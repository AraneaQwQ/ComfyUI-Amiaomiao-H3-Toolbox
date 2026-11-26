// H3 提示词: a plain prompt box. Typing @ (or clicking a chip) inserts the H3 tag of an active
// card in the connected 「H3 参考素材」; tags are coloured by kind, and tags no card answers to
// are marked. The text is stored in the node's own hidden "text" widget.
import { DIALOGUE_LANGUAGES, KIND_NAMES, PROMPT_TEMPLATES, danglingLabels, detectLanguage, dialogueIssues,
    filterItems, filterLanguages, insertTemplate, referenceItems, toggleDialogue, triggerAt } from "./refs_state.js";

const TEMPLATES = [
    ["keyframes", "首尾帧", "images", "首尾帧格式（三段）：integrated_multimodal_description / overall_soundscape / non_diegetic_music"],
    ["reference", "多参考", "clone", "多参考格式（六段）：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music"],
];
const FIELD_PATTERN = new RegExp(`^(?:${[...new Set(Object.values(PROMPT_TEMPLATES).flat())].join("|")}):`, "gm");
const FONT_SIZE_KEY = "amiaomiao-h3.prompt.font-size";
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 11;
const MAX_FONT_SIZE = 28;

function storedFontSize() {
    try {
        const size = Number(localStorage.getItem(FONT_SIZE_KEY));
        if (Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE) return size;
    } catch { /* display preference is optional */ }
    return DEFAULT_FONT_SIZE;
}

const KIND_ICONS = { image: "image", video: "video", audio: "volume-up" };
// reference tags and dialogue tags (<d>, </d> and the [Language] right after <d>)
const TAG_PATTERN = /(<(?:Picture|Video|Audio) \d+>|<d>(?:\[[^\]\n]*\])?|<\/d>)/g;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}
function icon(name) {
    const node = el("i", `pi pi-${name}`);
    node.setAttribute("aria-hidden", "true");
    return node;
}

export class PromptPanel {
    // source(): { doc, title } of the connected hub, or null. url(path): ComfyUI API URL.
    // language: { get(), set(value) } for the dialogue language, kept with the workflow.
    constructor({ value, onChange, source, url, language }) {
        this.onChange = onChange;
        this.source = source || (() => null);
        this.url = url || (path => path);
        this.language = language || { value: "auto", get() { return this.value; }, set(v) { this.value = v; } };
        this.items = [];
        this.connected = false;
        this.menu = null;
        this.root = el("div", "ahr ahp");
        this.build();
        this.setValue(value ?? "");
        this.refresh();
    }

    build() {
        const header = el("div", "ahp-header");
        const title = el("div", "ahr-title");
        title.append(icon("pencil"), el("span", "", "H3 提示词"));
        this.sourceBadge = el("span", "ahp-source");
        header.append(title, this.sourceBadge, this.buildFontControls());
        this.tools = el("div", "ahp-tools");
        this.tools.setAttribute("role", "toolbar");
        this.tools.setAttribute("aria-label", "格式");
        const dialogue = el("div", "ahp-dialogue");
        this.dialogueButton = el("button", "ahp-tool");
        this.dialogueButton.type = "button";
        this.dialogueButton.title = "对白：选中台词后点击，套上 <d>[语言] …</d>；再点一次取消（Ctrl+D）";
        this.dialogueButton.setAttribute("aria-label", "对白");
        this.dialogueButton.append(icon("comment"), el("span", "", "对白"), el("code", "", "<d>"));
        this.dialogueButton.addEventListener("pointerdown", event => event.preventDefault());
        this.dialogueButton.addEventListener("click", () => this.dialogue());
        this.languageSelect = el("select", "ahp-lang");
        this.languageSelect.title = "对白语言，自动 = 按台词文字判断";
        this.languageSelect.setAttribute("aria-label", "对白语言");
        for (const [value, text] of DIALOGUE_LANGUAGES) {
            const option = el("option", "", text);
            option.value = value;
            this.languageSelect.append(option);
        }
        this.languageSelect.value = DIALOGUE_LANGUAGES.some(([v]) => v === this.language.get()) ? this.language.get() : "auto";
        this.languageSelect.addEventListener("change", () => this.language.set(this.languageSelect.value));
        dialogue.append(this.dialogueButton, this.languageSelect);
        const templates = el("div", "ahp-templates");
        for (const [kind, name, glyph, tip] of TEMPLATES) {
            const button = el("button", "ahp-tool ahp-template");
            button.type = "button";
            button.title = tip;
            button.setAttribute("aria-label", `插入${name}格式`);
            button.append(icon(glyph), el("span", "", name));
            button.addEventListener("pointerdown", event => event.preventDefault());
            button.addEventListener("click", () => this.template(kind));
            templates.append(button);
        }
        this.tools.append(dialogue, templates);
        this.chips = el("div", "ahp-chips");
        this.chips.setAttribute("role", "toolbar");
        this.chips.setAttribute("aria-label", "插入素材编号");

        const editor = el("div", "ahp-editor");
        this.backdrop = el("div", "ahp-backdrop");
        this.backdrop.setAttribute("aria-hidden", "true");
        this.input = el("textarea", "ahp-input");
        this.input.spellcheck = false;
        this.input.placeholder = "输入或粘贴提示词，@ 引用素材";
        this.input.setAttribute("aria-label", "提示词");
        editor.append(this.backdrop, this.input);

        this.foot = el("div", "ahp-foot");
        this.warning = el("span", "ahp-warning");
        this.counter = el("span", "ahp-count");
        this.foot.append(this.warning, this.counter);
        this.root.append(header, this.tools, this.chips, editor, this.foot);
        this.setFontSize(storedFontSize());

        this.input.addEventListener("input", () => {
            this.paint();
            this.onChange(this.input.value);
            this.suggest();
        });
        this.input.addEventListener("scroll", () => this.syncScroll());
        this.input.addEventListener("select", () => this.updateTools());
        this.input.addEventListener("keyup", () => this.updateTools());
        this.input.addEventListener("mouseup", () => this.updateTools());
        this.input.addEventListener("keydown", event => this.onKey(event));
        this.input.addEventListener("click", () => this.suggest());
        this.input.addEventListener("blur", () => setTimeout(() => {
            if (!this.menu?.contains(document.activeElement)) this.closeMenu();
        }, 120));
        // the hub may have changed while the pointer was elsewhere
        this.root.addEventListener("pointerenter", () => this.refresh());
        this.input.addEventListener("focus", () => this.refresh());
    }

    buildFontControls() {
        const group = el("div", "ahp-font-controls");
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", "正文字号");
        const button = (label, glyph, action) => {
            const control = el("button", "ahp-tool");
            control.type = "button";
            control.title = label;
            control.setAttribute("aria-label", label);
            if (glyph) control.append(icon(glyph));
            control.addEventListener("pointerdown", event => event.preventDefault());
            control.addEventListener("click", action);
            return control;
        };
        this.fontSmaller = button("缩小字号", "minus", () => this.setFontSize(this.fontSize - 1, true));
        this.fontDefault = button("恢复默认字号", null, () => this.setFontSize(DEFAULT_FONT_SIZE, true));
        this.fontDefault.classList.add("ahp-font-value");
        this.fontLarger = button("放大字号", "plus", () => this.setFontSize(this.fontSize + 1, true));
        group.append(this.fontSmaller, this.fontDefault, this.fontLarger);
        return group;
    }

    setFontSize(size, remember = false) {
        this.fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
        this.root.style.setProperty("--ahp-font-size", `${this.fontSize}px`);
        this.fontDefault.textContent = String(this.fontSize);
        this.fontDefault.setAttribute("aria-label", `当前字号 ${this.fontSize}，恢复默认字号`);
        this.fontSmaller.disabled = this.fontSize <= MIN_FONT_SIZE;
        this.fontLarger.disabled = this.fontSize >= MAX_FONT_SIZE;
        if (remember) {
            try { localStorage.setItem(FONT_SIZE_KEY, String(this.fontSize)); } catch { /* display preference is optional */ }
            this.syncScroll();
            if (this.menu) this.placeMenu();
        }
    }

    setValue(text) {
        if (this.input.value === text) return;
        this.input.value = text;
        this.paint();
    }

    setLanguage(value) {
        this.languageSelect.value = DIALOGUE_LANGUAGES.some(([v]) => v === value) ? value : "auto";
    }

    template(kind) {
        const { value, selectionStart, selectionEnd } = this.input;
        const result = insertTemplate(value, selectionStart, selectionEnd, kind);
        this.input.focus();
        this.input.value = result.text;
        this.input.setSelectionRange(result.start, result.end);
        this.closeMenu();
        this.paint();
        this.updateTools();
        this.onChange(this.input.value);
        // bring the caret line into view
        this.input.blur();
        this.input.focus();
    }

    dialogue() {
        const { value, selectionStart, selectionEnd } = this.input;
        const scroll = this.input.scrollTop;
        const result = toggleDialogue(value, selectionStart, selectionEnd, this.languageSelect.value);
        this.input.focus();
        this.input.value = result.text;
        this.input.setSelectionRange(result.start, result.end);
        this.input.scrollTop = scroll;
        this.closeMenu();
        this.paint();
        this.updateTools();
        this.onChange(this.input.value);
    }

    // The button shows "取消对白" while the selection is a whole <d> block or sits right inside one.
    updateTools() {
        const { value, selectionStart: s, selectionEnd: e } = this.input;
        const selected = value.slice(s, e);
        const inside = /^<d>[\s\S]*<\/d>$/.test(selected)
            || (/<d>(?:\[[^\]\n]*\]\s*)?$/.test(value.slice(0, s)) && value.startsWith("</d>", e));
        this.dialogueButton.classList.toggle("is-on", inside);
        this.dialogueButton.setAttribute("aria-pressed", String(inside));
        this.dialogueButton.querySelector("span").textContent = inside ? "取消对白" : "对白";
        const auto = this.languageSelect.querySelector('option[value="auto"]');
        const guess = selected.trim() && !inside ? detectLanguage(selected) : "";
        const name = DIALOGUE_LANGUAGES.find(([v]) => v === guess)?.[1];
        auto.textContent = name ? `自动 · ${name}` : "自动";
    }

    refresh() {
        const source = this.source();
        this.connected = !!source;
        this.items = source ? referenceItems(source.doc) : [];
        this.sourceBadge.replaceChildren();
        this.sourceBadge.classList.toggle("is-off", !source);
        this.sourceBadge.title = source ? source.title || "H3 参考素材" : "未连接素材包";
        if (source) {
            const counts = ["image", "video", "audio"].map(kind => [kind, this.items.filter(i => i.kind === kind).length]);
            this.sourceBadge.append(icon("link"), el("span", "", this.sourceBadge.title));
            for (const [kind, count] of counts) {
                if (!count) continue;
                const pill = el("span", `ahp-count-pill is-${kind}`);
                pill.title = `启用的${KIND_NAMES[kind]}`;
                pill.append(icon(KIND_ICONS[kind]), el("span", "", String(count)));
                this.sourceBadge.append(pill);
            }
        } else {
            this.sourceBadge.append(icon("link"), el("span", "", "未连接素材包"));
        }
        this.renderChips();
        this.paint();
        if (this.menu) this.suggest();
    }

    renderChips() {
        // refresh() runs on every pointer enter; rebuilding would swallow a click in progress
        const signature = JSON.stringify(this.items.map(item => [item.id, item.label, item.name, item.purpose,
            item.card.filename, item.card.view?.cover_url]));
        if (signature === this.chipSignature) return;
        this.chipSignature = signature;
        this.chips.replaceChildren();
        this.chips.hidden = !this.items.length;
        for (const item of this.items) {
            const chip = el("button", `ahp-chip is-${item.kind}`);
            chip.type = "button";
            chip.title = `插入 ${item.label}${item.purpose ? " · " + item.purpose : ""}`;
            chip.append(this.thumb(item, "ahp-chip-thumb"), el("b", "", item.display), el("span", "", item.name));
            // keep the caret in the textarea
            chip.addEventListener("pointerdown", event => event.preventDefault());
            chip.addEventListener("click", () => this.insert(item));
            this.chips.append(chip);
        }
    }

    thumb(item, className) {
        const box = el("span", `${className} is-${item.kind}`);
        let src = "";
        if (item.kind === "image" && item.card.filename) {
            const query = new URLSearchParams({ filename: item.card.filename, subfolder: item.card.subfolder || "",
                type: item.card.type || "input" });
            src = this.url(`/amiaomiao_h3/lvm/image_thumbnail?${query}`);
        } else if (item.kind === "video" && item.card.view?.cover_url) {
            src = this.url(item.card.view.cover_url);
        }
        if (src) {
            const image = el("img");
            image.src = src;
            image.alt = "";
            image.draggable = false;
            image.addEventListener("error", () => image.replaceWith(icon(KIND_ICONS[item.kind])));
            box.append(image);
        } else {
            box.append(icon(KIND_ICONS[item.kind]));
        }
        return box;
    }

    // Coloured tags drawn under a transparent-background textarea with identical metrics.
    paint() {
        const text = this.input.value;
        const kinds = new Map(this.items.map(item => [item.label, item.kind]));
        const missing = this.connected ? danglingLabels(text, this.items) : [];
        const parts = [];
        let inDialogue = false;
        const span = () => el("span", "ahp-dline");
        let run = null;
        const pushText = piece => {
            if (!inDialogue) return parts.push(document.createTextNode(piece));
            run ||= (parts.push(span()), parts[parts.length - 1]);
            run.append(document.createTextNode(piece));
        };
        for (const piece of text.split(TAG_PATTERN)) {
            if (!piece) continue;
            if (piece.startsWith("<d>")) {
                parts.push(el("mark", "is-dialogue", piece));
                inDialogue = true; run = null;
            } else if (piece === "</d>") {
                parts.push(el("mark", "is-dialogue", piece));
                inDialogue = false; run = null;
            } else if (/^<(?:Picture|Video|Audio) \d+>$/.test(piece)) {
                const kind = kinds.get(piece) || (missing.includes(piece) ? "missing" : piece.includes("Audio") ? "audio" : "plain");
                parts.push(el("mark", `is-${this.connected ? kind : "plain"}`, piece));
                run = null;
            } else {
                pushText(piece);
            }
        }
        parts.push(document.createTextNode("\n"));
        this.backdrop.replaceChildren(...parts);
        this.markFields();
        this.syncScroll();
        this.warning.replaceChildren();
        const problems = [];
        if (missing.length) {
            problems.push(`${missing.join("、")} 没有对应的启用素材`);
        }
        const issues = dialogueIssues(text);
        if (issues.unclosed) problems.push(`${issues.unclosed} 处 <d> 没有闭合`);
        if (issues.stray) problems.push(`${issues.stray} 处多余的 </d>`);
        if (problems.length) {
            this.warning.append(icon("exclamation-triangle"), el("span", "", problems.join("；")));
        }
        this.counter.textContent = text.length ? `${text.length} 字` : "";
    }

    // Section titles at the start of a line ("summary:") get a quiet highlight in the backdrop.
    markFields() {
        const walker = document.createTreeWalker(this.backdrop, NodeFilter.SHOW_TEXT);
        // walk every text node (marks included) so "line start" follows the real text
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        let lineStart = true;
        for (const node of nodes) {
            const value = node.nodeValue;
            if (node.parentElement.closest("mark")) { lineStart = value.endsWith("\n"); continue; }
            // text nodes split at tags; only treat "^" as a line start when the node really starts a line
            const pattern = new RegExp(FIELD_PATTERN.source, "gm");
            const pieces = [];
            let last = 0;
            for (const match of value.matchAll(pattern)) {
                if (match.index === 0 && !lineStart) continue;
                pieces.push(document.createTextNode(value.slice(last, match.index)), el("mark", "is-field", match[0]));
                last = match.index + match[0].length;
            }
            if (pieces.length) {
                pieces.push(document.createTextNode(value.slice(last)));
                node.replaceWith(...pieces.filter(piece => piece.nodeType !== 3 || piece.nodeValue));
            }
            lineStart = value.endsWith("\n");
        }
    }

    syncScroll() {
        this.backdrop.scrollTop = this.input.scrollTop;
        this.backdrop.scrollLeft = this.input.scrollLeft;
    }

    insert(item, start = this.input.selectionStart, end = this.input.selectionEnd) {
        const scroll = this.input.scrollTop;
        const after = this.input.value.slice(end, end + 1);
        this.input.focus();
        this.input.setRangeText(item.label + (after === " " ? "" : " "), start, end, "end");
        if (after === " ") this.input.selectionStart = this.input.selectionEnd = this.input.selectionEnd + 1;
        this.input.scrollTop = scroll;
        this.closeMenu();
        this.paint();
        this.onChange(this.input.value);
    }

    suggest() {
        const { selectionStart, selectionEnd, value } = this.input;
        const caret = selectionStart === selectionEnd ? selectionStart : -1;
        const mention = caret < 0 ? null : triggerAt(value, caret, "@") || triggerAt(value, caret, "#");
        if (!mention) return this.closeMenu();
        this.mention = mention;
        if (mention.char === "#") this.openDialogueMenu(filterLanguages(mention.query));
        else this.openMenu(filterItems(this.items, mention.query));
    }

    menuShell(label, kind) {
        const fresh = !this.menu || this.menu.dataset.kind !== kind;
        if (!this.menu) {
            this.menu = el("div", "ahp-menu");
            this.menu.setAttribute("role", "listbox");
            this.menu.addEventListener("pointerdown", event => event.preventDefault());
            document.body.append(this.menu);
        }
        this.menu.dataset.kind = kind;
        this.menu.setAttribute("aria-label", label);
        this.menu.replaceChildren();
        return fresh;
    }

    // "#": insert <d>[Language] </d> at the caret, caret between the tags.
    openDialogueMenu(languages) {
        const fresh = this.menuShell("插入对白", "dialogue");
        // start on the toolbar's language (Chinese when it is on auto)
        if (fresh || this.lastQuery !== this.mention.query) {
            const chosen = this.languageSelect.value === "auto" ? "Chinese" : this.languageSelect.value;
            this.active = Math.max(0, languages.findIndex(lang => lang.value === chosen));
        }
        this.lastQuery = this.mention.query;
        this.menuItems = languages.map(lang => ({ dialogue: lang.value }));
        this.active = Math.min(this.active ?? 0, Math.max(0, languages.length - 1));
        const head = el("div", "ahp-menu-head");
        head.append(icon("comment"), el("span", "", "插入对白"), el("code", "", "<d>[…] </d>"));
        this.menu.append(head);
        if (!languages.length) this.menu.append(el("div", "ahp-menu-empty", "没有这种语言"));
        languages.forEach((lang, index) => {
            const row = el("div", "ahp-option is-dialogue");
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(index === this.active));
            const badge = el("span", "ahp-option-thumb is-dialogue");
            badge.append(icon("comment"));
            const text = el("div", "ahp-option-text");
            const line = el("div", "ahp-option-line");
            line.append(el("b", "", lang.name), el("span", "", lang.value));
            const meta = el("div", "ahp-option-meta");
            meta.append(el("code", "", `<d>[${lang.value}] </d>`));
            text.append(line, meta);
            row.append(badge, text);
            row.addEventListener("pointermove", () => { if (this.active !== index) { this.active = index; this.markActive(); } });
            row.addEventListener("click", () => this.insertDialogue(lang.value));
            this.menu.append(row);
        });
        this.placeMenu();
    }

    insertDialogue(language) {
        const { start, end } = this.mention;
        const scroll = this.input.scrollTop;
        const open = `<d>[${language}] `;
        this.input.focus();
        this.input.setRangeText(open + "</d>", start, end, "start");
        this.input.setSelectionRange(start + open.length, start + open.length);
        this.input.scrollTop = scroll;
        this.closeMenu();
        this.paint();
        this.updateTools();
        this.onChange(this.input.value);
    }

    pick(index) {
        const item = this.menuItems[index];
        if (!item) return;
        if (item.dialogue) this.insertDialogue(item.dialogue);
        else this.insert(item, this.mention.start, this.mention.end);
    }

    openMenu(items) {
        if (this.menuShell("选择素材", "refs")) this.active = 0;
        this.menuItems = items;
        this.active = Math.min(this.active ?? 0, Math.max(0, items.length - 1));
        if (!items.length) {
            this.menu.append(el("div", "ahp-menu-empty", !this.connected ? "未连接素材包"
                : this.items.length ? "没有匹配的素材" : "素材包里没有启用的素材"));
        }
        items.forEach((item, index) => {
            const row = el("div", `ahp-option is-${item.kind}`);
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(index === this.active));
            const text = el("div", "ahp-option-text");
            const line = el("div", "ahp-option-line");
            line.append(el("b", "", item.display), el("span", "", item.name));
            const meta = el("div", "ahp-option-meta");
            meta.append(el("code", "", item.label));
            if (item.purpose) meta.append(el("span", "", item.purpose));
            if (item.withAudio) meta.append(el("span", "ahp-tag-audio", "Video Audio"));
            text.append(line, meta);
            row.append(this.thumb(item, "ahp-option-thumb"), text);
            row.addEventListener("pointermove", () => { if (this.active !== index) { this.active = index; this.markActive(); } });
            row.addEventListener("click", () => this.insert(item, this.mention.start, this.mention.end));
            this.menu.append(row);
        });
        this.placeMenu();
    }

    markActive() {
        [...this.menu.querySelectorAll(".ahp-option")].forEach((row, index) => {
            row.setAttribute("aria-selected", String(index === this.active));
            if (index === this.active) row.scrollIntoView({ block: "nearest" });
        });
    }

    placeMenu() {
        const anchor = this.caretPoint();
        const width = 300;
        const height = Math.min(this.menu.scrollHeight, 320);
        let left = Math.min(anchor.left, window.innerWidth - width - 8);
        let top = anchor.bottom + 6;
        if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - height - 6);
        Object.assign(this.menu.style, { left: `${Math.max(8, left)}px`, top: `${top}px`, width: `${width}px` });
    }

    // Caret position on screen: mirror the textarea's text up to the caret in a hidden div.
    caretPoint() {
        const editor = this.input;
        const mirror = el("div");
        const style = getComputedStyle(editor);
        for (const key of ["boxSizing", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
            "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
            "borderBottomWidth", "borderLeftWidth", "tabSize"]) mirror.style[key] = style[key];
        Object.assign(mirror.style, { position: "fixed", left: "-10000px", top: "0", width: `${editor.clientWidth}px`,
            borderStyle: "solid", whiteSpace: "pre-wrap", overflowWrap: "break-word", visibility: "hidden" });
        mirror.textContent = editor.value.slice(0, editor.selectionStart);
        const caret = el("span", "", "\u200b");
        mirror.append(caret);
        document.body.append(mirror);
        const rect = editor.getBoundingClientRect(), bounds = mirror.getBoundingClientRect();
        const point = caret.getBoundingClientRect();
        const scale = editor.offsetWidth ? rect.width / editor.offsetWidth : 1;
        mirror.remove();
        const top = rect.top + (point.top - bounds.top - editor.scrollTop) * scale;
        const clamp = value => Math.min(Math.max(value, rect.top), rect.bottom);
        return { left: rect.left + (point.left - bounds.left) * scale, top: clamp(top),
            bottom: clamp(top + point.height * scale) };
    }

    closeMenu() {
        this.menu?.remove();
        this.menu = null;
        this.active = null;
    }

    onKey(event) {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "d") {
            event.preventDefault();
            event.stopPropagation();
            this.dialogue();
            return;
        }
        if (!this.menu) return;
        const count = this.menuItems.length;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (!count) return;
            event.preventDefault();
            this.active = (this.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
            this.markActive();
        } else if ((event.key === "Enter" || event.key === "Tab") && count) {
            event.preventDefault();
            this.pick(this.active);
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            this.closeMenu();
        }
    }

    dispose() {
        this.closeMenu();
    }
}
