import { ComposerPanel as LegacyPanel } from "./editor.js";
import { FIELD_GUIDANCE } from "./catalog.js";
import { FIELDS, defaultDocument, createHistory, runsFromText, textFromRuns } from "./state.js";
import { FIELD_NAMES, PRESETS, TASK_TYPES, VISUAL_RELATIONS, AUDIO_RELATIONS,
    MARKERS, expandPreset, splitNative, speakerNumber, summaryParts, toggleSummaryTask, summaryPreset,
    SUMMARY_REFERENCE_PRESET, plannedShotCount, shotScope, completeShotOutline, REFERENCE_PRESET_GROUPS,
    BUTTON_LABELS, BUTTON_HELP, DETAILED_PRESET_GROUPS, referenceCategory, joinFields } from "./text_presets.js";

const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
};
const FIELD_ICONS = ["users", "file", "sliders-h", "video", "volume-up", "headphones"];
function glyph(name, className = "") {
    const icon = element("i", `pi pi-${name} ${className}`.trim());
    icon.setAttribute("aria-hidden", "true");
    return icon;
}
function fieldGuidance(key) {
    const data = FIELD_GUIDANCE[key];
    const guide = element("details", "h3p-field-guidance");
    const summary = element("summary", "", "填写规则与格式参考");
    summary.prepend(glyph("info-circle"));
    const body = element("div", "h3p-guidance-body");
    body.append(element("p", "", data.purpose),
        element("strong", "", key === "native" ? "六段结构模板（占位内容需填写）" : "格式参考（标签与内容仅作说明，请按实际填写）"),
        element("pre", "h3p-guidance-example", data.example));
    const caution = element("div", "h3p-guidance-caution");
    const label = element("strong", "", "重点注意");
    label.prepend(glyph("exclamation-triangle"));
    caution.append(label, element("p", "", data.caution));
    const behavior = element("div", "h3p-guidance-behavior");
    behavior.append(element("strong", "", "本节点如何处理"), element("p", "", data.node));
    body.append(caution, behavior);
    guide.append(summary, body);
    guide.dataset.guidanceField = key;
    return guide;
}
function button(label, action, icon) {
    const control = element("button", "h3p-button", BUTTON_LABELS[label] || label);
    control.type = "button";
    if (BUTTON_HELP[label]) control.dataset.tooltip = BUTTON_HELP[label];
    if (icon) {
        const glyph = element("i", `pi pi-${icon}`);
        glyph.setAttribute("aria-hidden", "true");
        control.prepend(glyph);
    }
    control.addEventListener("click", action);
    return control;
}
function hasOverallStyle(text) {
    return /(?:^|\n)\s*(?:整体(?:采用|画风|风格)|全片(?:采用|画风|风格)|(?:视觉风格|画风)\s*[:：])/.test(text);
}

export class ComposerPanel extends LegacyPanel {
    resetDraft() {
        this.closeReferenceMenu();
        const previous = this.doc;
        this.doc = {
            ...defaultDocument(),
            assets: previous.assets,
            text_fields: Object.fromEntries(FIELDS.map(key => [key, ""])),
            ui: { ...previous.ui, shot_count: 1,
                detailed_template_initialized: false, native_template_initialized: true },
        };
        this.initializeDetailedTemplate();
        this.doc.mode = previous.mode;
        this.doc.native_text = joinFields(this.doc.text_fields);
        this.lastCompiled = null;
        this.compiledVersion = null;
        this.commit();
        this.render();
    }
    initializeDetailedTemplate() {
        if (!this.doc.text_fields || this.doc.ui.detailed_template_initialized) return false;
        this.doc.ui.detailed_template_initialized = true;
        const blank = FIELDS.every(key => !this.doc.text_fields[key]?.trim());
        if (this.doc.mode === "compose" && blank && !this.doc.native_text.trim()) {
            const style = PRESETS.detailed_description.find(([label]) => label === "整体画风")[1];
            this.doc.text_fields.detailed_description = style + "\n\n" + completeShotOutline("", 1);
        }
        return true;
    }
    load(raw) {
        super.load(raw);
        if (this.doc && this.initializeDetailedTemplate()) {
            this.history = createHistory(this.doc);
            this.onChange(JSON.stringify(this.doc));
            this.render();
        }
    }
    commit(key) {
        if (this.insertingCommand) key = undefined;
        super.commit(key);
        this.refreshTaskButtons();
    }
    refreshTaskButtons() {
        const tasks = summaryParts(this.doc.text_fields?.summary || "").tasks;
        const overview = this.root.querySelector("[data-summary-overview]");
        if (overview) overview.disabled = /目标视频呈现|目标视频是|的末尾继续/.test(this.doc.text_fields?.summary || "");
        const style = this.root.querySelector("[data-overall-style]");
        if (style) {
            style.disabled = hasOverallStyle(this.doc.text_fields?.detailed_description || "");
            style.dataset.tooltip = style.disabled ? "已添加整体画风，请直接编辑正文；删除这段后可重新添加。" : BUTTON_HELP["整体画风"];
        }
        for (const control of this.root.querySelectorAll("[data-task]")) {
            const active = tasks.includes(control.dataset.task);
            control.classList.toggle("h3p-active", active);
            control.setAttribute("aria-pressed", String(active));
        }
    }
    bindMedia(fields) {
        const references = this.activeReferences();
        return Object.fromEntries(FIELDS.map(key => [key,
            fields[key].replace(/<(Picture|Video|Audio)\s+(\d+)>/g, label => {
                const matches = references.filter(item => item.formal === label);
                return matches.length === 1 ? `{{ref:${matches[0].id}}}` : label;
            }),
        ]));
    }
    async compileNow() {
        clearTimeout(this.compileTimer);
        const version = this.version;
        try {
            const legacy = !this.doc.text_fields;
            const request = legacy ? { ...this.doc, mode: "compose" } : this.doc;
            const result = await this.post("compile", { document: request });
            if (this.disposed || version !== this.version) return null;
            if (legacy) {
                const native = this.doc.mode === "native" && splitNative(this.doc.native_text);
                const hasContent = this.doc.definitions.length || this.doc.summary || this.doc.style
                    || this.doc.shots.some(shot => shot.runs?.length) || this.doc.soundscape
                    || this.doc.music.text || Object.keys(this.doc.overrides).length || this.doc.mc.enabled;
                this.doc.text_fields = this.bindMedia(native || (hasContent ? result.fields :
                    Object.fromEntries(FIELDS.map(key => [key, ""]))));
                this.initializeDetailedTemplate();
                this.onChange(JSON.stringify(this.doc));
                this.history = createHistory(this.doc);
                this.render();
                return this.compileNow();
            }
            this.lastCompiled = result;
            this.compiledVersion = version;
            this.renderResults();
            return result;
        } catch (error) {
            if (!this.disposed && version === this.version) this.setStatus(error.message, true);
            return null;
        }
    }
    async switchMode(mode) {
        if (mode === this.doc.mode || this.switching || !this.doc.text_fields) return;
        this.switching = true;
        try {
            if (mode === "native") {
                this.importNotice = "";
                const result = await this.compileNow();
                if (!result) return;
                this.doc.native_text = result.prompt;
            } else {
                const parsed = splitNative(this.doc.native_text);
                const fields = parsed || Object.fromEntries(FIELDS.map(key =>
                    [key, key === "detailed_description" ? this.doc.native_text : ""]));
                this.importNotice = !parsed && this.doc.native_text.trim()
                    ? "未分区的正文已放入“详细描述”，可继续编辑。" : "";
                if (!parsed) this.doc.ui.active_field = "detailed_description";
                this.doc.text_fields = this.bindMedia(fields);
            }
            this.doc.mode = mode;
            this.commit();
            this.render();
        } finally { this.switching = false; }
    }
    activeReferences() {
        return this.doc.assets.filter(asset => !asset.skip && !asset.missing).flatMap(asset => {
            const kind = { image: "Picture", video: "Video", audio: "Audio" }[asset.kind];
            const item = { ...asset, target: "ref", formal: asset.slot ? `<${kind} ${asset.slot}>` : "",
                label: asset.alias || asset.label || "未命名素材" };
            const audio = asset.kind === "video" && asset.audio_enabled
                ? [{ ...item, id: asset.id + "#audio", kind: "audio",
                    formal: asset.audio_slot ? `<Audio ${asset.audio_slot}>` : "", label: item.label + " · 原音轨" }] : [];
            return [item, ...audio];
        });
    }
    fillReference(chip) {
        const item = this.activeReferences().find(asset => asset.id === chip.dataset.refId);
        chip.replaceChildren();
        if (item?.thumbnail_url) {
            const image = element("img");
            image.src = item.thumbnail_url; image.alt = ""; image.loading = "lazy"; chip.append(image);
        }
        chip.append(document.createTextNode(item ? `${item.formal || "待确认编号"} ${item.label}` : "失效引用"));
        chip.classList.toggle("h3p-invalid", !item || !item.formal);
        chip.title = item?.source || "素材已停用或失效";
    }
    runElement(run, editor, save) {
        if (run.kind === "text" && /【(?:@|选择镜头|生效位置|选择可视关系|选择音频关系|选择说话或唱歌|关系值)[^】]*】/.test(run.text)) {
            const fragment = document.createDocumentFragment();
            for (const part of run.text.split(/(【(?:@|选择镜头|生效位置|选择可视关系|选择音频关系|选择说话或唱歌|关系值)[^】]*】)/g)) {
                if (!/^【(?:@|选择镜头|生效位置|选择可视关系|选择音频关系|选择说话或唱歌|关系值)/.test(part)) {
                    fragment.append(document.createTextNode(part)); continue;
                }
                const slot = element("span", "h3p-reference-placeholder", part);
                slot.title = "选择引用";
                slot.addEventListener("click", () => {
                    if (!part.startsWith("【@")) {
                        this.openPlaceholderMenu(editor, slot, part); return;
                    }
                    const context = this.referenceContext(editor, slot);
                    const category = referenceCategory(editor.dataset.path, part, context.before, context.after);
                    this.openReferenceMenu(editor, item => {
                        if (!editor.contains(slot)) return;
                        const range = document.createRange(); range.selectNode(slot);
                        let speech = "";
                        const following = slot.nextSibling;
                        const marker = following?.nodeType === Node.TEXT_NODE
                            && following.textContent.match(/^\(S【(?:编号|自动)】\)/);
                        if (item.target === "subject" && marker) {
                            speech = `(S${speakerNumber(this.doc.text_fields, item.id)})`;
                            following.textContent = following.textContent.slice(marker[0].length);
                        }
                        range.deleteContents();
                        const replacement = this.runElement({ kind: "ref", target: item.target, id: item.id }, editor, save);
                        range.insertNode(replacement);
                        range.collapse(false);
                        if (speech) {
                            const text = document.createTextNode(speech);
                            range.insertNode(text); range.setStartAfter(text); range.collapse(true);
                        }
                        editor.focus();
                        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
                        editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
                    }, "", category, slot.getBoundingClientRect());
                });
                fragment.append(slot);
            }
            return fragment;
        }
        if (run.kind === "ref" && run.target === "subject") return document.createTextNode(run.id);
        return super.runElement(run, editor, save);
    }
    referenceContext(editor, slot = null) {
        const selection = window.getSelection();
        const range = slot ? document.createRange() : selection.rangeCount
            && editor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
        if (!range) return { before: "", after: "", placeholder: "" };
        if (slot) range.selectNode(slot);
        const text = fragment => {
            for (const br of fragment.querySelectorAll("br")) br.replaceWith("\n");
            for (const block of fragment.querySelectorAll("div,p")) block.append("\n");
            return fragment.textContent;
        };
        const before = document.createRange(); before.selectNodeContents(editor);
        before.setEnd(range.startContainer, range.startOffset);
        const after = document.createRange(); after.selectNodeContents(editor);
        after.setStart(range.endContainer, range.endOffset);
        return {
            before: text(before.cloneContents()).split("\n").at(-1),
            after: text(after.cloneContents()).split("\n")[0],
            placeholder: (slot || selection.anchorNode?.parentElement?.closest(".h3p-reference-placeholder"))?.textContent || "",
        };
    }
    closeReferenceMenu(restoreFocus = false) {
        const editor = this.referenceEditor;
        this.referenceDismiss?.abort();
        this.referenceDismiss = null;
        this.referenceEditor = null;
        super.closeReferenceMenu();
        if (restoreFocus && editor?.isConnected) editor.focus({ preventScroll: true });
    }
    referenceHeader(popup, title) {
        const header = element("div", "h3p-reference-header");
        const close = button("", () => this.closeReferenceMenu(true), "times");
        close.setAttribute("aria-label", "关闭");
        close.title = "关闭";
        close.classList.add("h3p-reference-close");
        header.append(element("h3", "", title), close);
        popup.append(header);
    }
    mountReferenceMenu(popup, editor, anchor) {
        document.body.append(popup);
        this.referenceMenu = popup;
        this.referenceEditor = editor;
        const dismiss = this.referenceDismiss = new AbortController();
        document.addEventListener("pointerdown", event => {
            if (!popup.contains(event.target)) this.closeReferenceMenu();
        }, { capture: true, signal: dismiss.signal });
        document.addEventListener("keydown", event => {
            if (event.key !== "Escape" || event.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            this.closeReferenceMenu(true);
        }, { capture: true, signal: dismiss.signal });
        for (const name of ["pointerdown", "mousedown", "click", "dblclick", "wheel"]) {
            popup.addEventListener(name, event => event.stopPropagation());
        }
        this.positionPopup(popup, editor, anchor);
    }
    openReferenceMenu(editor, insert, query = "", category = "all", anchor = null) {
        this.closeReferenceMenu();
        if (category === "all") {
            const context = this.referenceContext(editor);
            category = referenceCategory(editor.dataset.path, context.placeholder, context.before, context.after);
        }
        const allowedKinds = category === "visual" ? ["image", "video"]
            : category === "visible" ? ["image", "video", "subject"]
            : category === "media" ? ["image", "audio", "video"]
            : category === "all" ? ["image", "audio", "video", "subject"] : [category];
        if (["visual", "visible", "media"].includes(category)) category = "all";
        const popup = element("div", "h3p-root h3p-reference-menu");
        popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", "选择引用");
        this.referenceHeader(popup, "选择引用");
        const search = element("input", "h3p-input");
        const searchHint = allowedKinds.length === 1 ? {
            image: "搜索图片", audio: "搜索音频", video: "搜索视频", subject: "搜索已定义主体",
        }[allowedKinds[0]] : allowedKinds.includes("audio") ? allowedKinds.includes("subject") ? "搜索素材或主体" : "搜索素材"
            : allowedKinds.includes("subject") ? "搜索图片、视频或主体" : "搜索图片或视频";
        search.value = query; search.placeholder = searchHint;
        search.setAttribute("aria-label", searchHint);
        const results = element("div", "h3p-reference-results");
        const subjects = [...new Set(this.doc.text_fields.subject_definitions.match(/<Subject\s+\d+>/g) || [])]
            .map(label => ({ id: label, target: "subject", label, formal: label, kind: "subject" }));
        const items = [...subjects, ...this.activeReferences()].filter(item => allowedKinds.includes(item.kind));
        const tabs = element("div", "h3p-reference-tabs");
        const categories = [["all", "全部"], ["image", "图片"], ["audio", "音频"], ["video", "视频"], ["subject", "主体"]];
        for (const [kind, name] of categories) {
            if (kind === "all" ? allowedKinds.length === 1 : !allowedKinds.includes(kind)) continue;
            const tab = button(name, () => { category = kind; list(); });
            tab.dataset.category = kind; tabs.append(tab);
        }
        const choose = item => { this.closeReferenceMenu(); insert(item); };
        const list = () => {
            results.replaceChildren();
            for (const tab of tabs.children) {
                tab.classList.toggle("h3p-active", tab.dataset.category === category);
                tab.setAttribute("aria-pressed", String(tab.dataset.category === category));
            }
            const visible = items.filter(item => (category === "all" || item.kind === category) &&
                `${item.label} ${item.formal} ${item.source || ""}`.toLowerCase().includes(search.value.toLowerCase()));
            for (const item of visible) {
                const control = button("", () => choose(item));
                if (editor.tagName === "TEXTAREA" && !item.formal) {
                    control.disabled = true; control.title = "素材编号尚未确认，请先刷新素材。";
                }
                control.classList.add("h3p-reference-choice");
                control.setAttribute("aria-label", `引用 ${item.formal || item.label}`);
                if (item.thumbnail_url) {
                    const image = element("img");
                    image.src = item.thumbnail_url; image.alt = ""; control.append(image);
                }
                const title = item.target === "subject" ? item.label : `${item.formal || "待确认编号"} ${item.label}`;
                control.append(element("span", "", title));
                if (item.source) control.lastChild.append(element("small", "", item.source));
                results.append(control);
            }
            if (!visible.length) results.append(element("p", "h3p-note", allowedKinds.length === 1
                ? `没有匹配的${{ image: "激活图片", audio: "激活音频", video: "激活视频", subject: "已定义主体" }[allowedKinds[0]]}。`
                : allowedKinds.includes("subject") ? "没有匹配的激活素材或主体。" : "没有匹配的激活素材。"));
        };
        search.addEventListener("input", list);
        popup.append(tabs, search, results);
        popup.addEventListener("pointerdown", event => {
            if (event.target.closest(".h3p-reference-choice")) event.preventDefault();
        });
        popup.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Enter" && event.target === search) {
                event.preventDefault(); results.querySelector("button:not(:disabled)")?.click();
            }
        });
        list();
        this.mountReferenceMenu(popup, editor, anchor);
    }
    positionPopup(popup, editor, anchor) {
        const rect = editor.getBoundingClientRect();
        const scale = Math.max(1, Math.min(1.6, rect.width / (editor.offsetWidth || rect.width)));
        popup.style.zoom = String(scale);
        popup.style.width = `${Math.min(640 * scale, window.innerWidth - 24) / scale}px`;
        popup.style.height = `${Math.min(560 * scale, window.innerHeight - 24) / scale}px`;
        popup.style.maxHeight = popup.style.height;
        if (!anchor) {
            const selection = window.getSelection();
            if (selection.rangeCount && editor.contains(selection.anchorNode)) {
                const caret = selection.getRangeAt(0).getBoundingClientRect();
                if (caret.height) anchor = caret;
            }
        }
        anchor ||= { left: rect.left, top: rect.top, bottom: rect.top + 32 };
        const bounds = popup.getBoundingClientRect();
        const below = window.innerHeight - anchor.bottom - 12;
        const above = anchor.top - 12;
        const top = below >= bounds.height || below >= above ? anchor.bottom + 8 : anchor.top - bounds.height - 8;
        popup.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12)) / scale}px`;
        popup.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12)) / scale}px`;
    }
    replacePlaceholder(editor, slot, value) {
        if (!editor.contains(slot)) return;
        const text = document.createTextNode(value);
        slot.replaceWith(text);
        editor.focus();
        const range = document.createRange(); range.setStartAfter(text); range.collapse(true);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        editor.savedRange = range.cloneRange();
        this.insertingCommand = true;
        try { editor.dispatchEvent(new InputEvent("input", { bubbles: true })); }
        finally { this.insertingCommand = false; }
    }
    openPlaceholderMenu(editor, slot, placeholder) {
        this.closeReferenceMenu();
        const isScope = /选择镜头|生效位置/.test(placeholder);
        const isPerformance = placeholder.includes("选择说话或唱歌");
        const audio = placeholder.includes("音频");
        const title = isPerformance ? "选择原声用途" : isScope ? "选择生效镜头" : audio ? "选择音频关系" : "选择可视关系";
        const popup = element("div", "h3p-root h3p-reference-menu");
        popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", title);
        this.referenceHeader(popup, title);
        const results = element("div", "h3p-reference-results");
        const choose = value => {
            this.closeReferenceMenu(); this.replacePlaceholder(editor, slot, value);
        };
        if (isPerformance) {
            for (const name of ["说话", "唱歌"]) {
                const control = button(name, () => choose(name));
                control.classList.add("h3p-reference-choice");
                results.append(control);
            }
            popup.append(results);
        } else if (isScope) {
            const choices = [];
            const actions = element("div", "h3p-row");
            actions.append(button("全选", () => { for (const control of choices) control.checked = true; update(); }),
                button("清空", () => { for (const control of choices) control.checked = false; update(); }));
            popup.append(actions);
            for (let index = 1; index <= plannedShotCount(this.doc); index++) {
                const label = element("label", "h3p-check h3p-shot-choice");
                const control = element("input"); control.type = "checkbox"; control.value = String(index);
                control.setAttribute("aria-label", `Shot ${index}`);
                control.addEventListener("change", () => update());
                label.append(control, document.createTextNode(`Shot ${index}`));
                results.append(label); choices.push(control);
            }
            const apply = button("确认镜头", () => choose(shotScope(
                choices.filter(control => control.checked).map(control => Number(control.value)))));
            const update = () => { apply.disabled = !choices.some(control => control.checked); };
            update(); popup.append(results, apply);
        } else {
            for (const [name, value] of audio ? AUDIO_RELATIONS : VISUAL_RELATIONS) {
                const control = button("", () => choose(value));
                control.classList.add("h3p-reference-choice");
                control.append(element("strong", "", BUTTON_LABELS[name] || name), element("small", "", value));
                control.title = BUTTON_HELP[value] || "";
                results.append(control);
            }
            popup.append(results);
        }
        popup.addEventListener("keydown", event => {
            event.stopPropagation();
        });
        this.mountReferenceMenu(popup, editor, slot.getBoundingClientRect());
    }
    renderAssetCard(asset, parent) {
        const card = element("article", "h3p-asset-card");
        card.dataset.assetId = asset.id;
        const preview = button("", () => this.previewAsset(asset), asset.kind === "audio" ? "volume-up" : "play");
        preview.classList.add("h3p-asset-preview"); preview.setAttribute("aria-label", "预览 " + asset.label);
        if (asset.thumbnail_url) {
            const image = element("img"); image.src = asset.thumbnail_url;
            image.alt = asset.label; image.loading = "lazy"; preview.prepend(image);
        }
        card.append(preview, element("strong", "h3p-asset-name", asset.alias || asset.label));
        const alias = element("input", "h3p-input"); alias.value = asset.alias || "";
        alias.placeholder = "素材别名"; alias.setAttribute("aria-label", "素材别名");
        alias.addEventListener("input", () => { asset.alias = alias.value; this.commit("asset." + asset.id); });
        card.append(alias);
        const slotInput = (name, key) => {
            const label = element("label", "h3p-field");
            const control = element("input", "h3p-input");
            control.type = "number"; control.min = "1"; control.max = "99"; control.step = "1";
            control.value = asset[key] ?? ""; control.placeholder = "待确认";
            control.setAttribute("aria-label", name);
            control.addEventListener("input", () => {
                asset[key] = control.value === "" ? null : Number(control.value);
                this.commit("slot." + asset.id + "." + key);
            });
            label.append(element("span", "", name), control); card.append(label);
        };
        if (asset.kind === "image" || asset.kind === "audio") {
            const kind = asset.kind === "image" ? "Picture" : "Audio";
            card.append(element("span", "h3p-asset-number",
                asset.slot == null ? "素材编号待刷新" : `<${kind} ${asset.slot}>`));
        } else {
            slotInput("Video 编号", "slot");
        }
        if (asset.kind === "video") {
            const label = element("label", "h3p-check");
            const enabled = element("input"); enabled.type = "checkbox"; enabled.checked = !!asset.audio_enabled;
            enabled.addEventListener("change", () => this.structural(() => { asset.audio_enabled = enabled.checked; }));
            label.append(enabled, document.createTextNode("启用原音轨")); card.append(label);
            if (asset.audio_enabled) slotInput("原音轨 Audio 编号", "audio_slot");
        }
        parent.append(card);
    }
    captureRange(editor) {
        const selection = window.getSelection();
        if (selection.rangeCount && editor.contains(selection.anchorNode)) {
            editor.savedRange = selection.getRangeAt(0).cloneRange();
        }
    }
    insertText(editor, text, paragraph = false) {
        editor.focus();
        const range = editor.savedRange?.cloneRange() || document.createRange();
        if (!editor.savedRange || !editor.contains(range.startContainer)
            || paragraph && (editor.pendingPreset || editor.dataset.path === "retention_analysis")) {
            range.selectNodeContents(editor); range.collapse(false);
        }
        if (paragraph) {
            const before = document.createRange(); before.selectNodeContents(editor);
            before.setEnd(range.startContainer, range.startOffset);
            if (before.toString() && !before.toString().endsWith("\n")) text = "\n" + text;
        }
        range.deleteContents();
        const content = this.runElement({ kind: "text", text }, editor, () => {});
        const nodes = content.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? [...content.childNodes] : [content];
        range.insertNode(content);
        const placeholder = /【[^】]*】/.exec(text);
        const slot = nodes.find(node => node.nodeType === Node.ELEMENT_NODE
            && node.classList.contains("h3p-reference-placeholder"));
        if (slot && placeholder?.index === nodes[0].textContent.length) range.selectNodeContents(slot);
        else {
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
            let found = false;
            while (walker.nextNode()) {
                if (!nodes.some(node => node === walker.currentNode || node.contains?.(walker.currentNode))) continue;
                const match = walker.currentNode.textContent.match(/【[^】]*】/);
                if (!match) continue;
                range.setStart(walker.currentNode, match.index);
                range.setEnd(walker.currentNode, match.index + match[0].length);
                found = true; break;
            }
            if (!found) { range.setStartAfter(nodes.at(-1)); range.collapse(true); }
        }
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        editor.savedRange = range.cloneRange();
        this.insertingCommand = true;
        try { editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })); }
        finally { this.insertingCommand = false; }
        editor.pendingPreset = paragraph;
    }
    insertOverallStyle(editor) {
        const current = this.doc.text_fields.detailed_description;
        if (hasOverallStyle(current)) return;
        const range = document.createRange(); range.selectNodeContents(editor); range.collapse(true);
        editor.savedRange = range; editor.pendingPreset = false;
        const template = new Map(PRESETS.detailed_description).get("整体画风");
        this.insertText(editor, template + (current ? "\n\n" : ""));
        editor.pendingPreset = true;
    }
    menu(parent, title, options, choose) {
        const details = element("details", "h3p-insert-menu");
        const summary = element("summary", "h3p-button", title);
        if (BUTTON_HELP[title]) summary.title = BUTTON_HELP[title];
        const choices = element("div", "h3p-insert-choices");
        for (const [label, text] of options) choices.append(button(label, () => {
            details.open = false; choose(text);
        }));
        details.append(summary, choices); parent.append(details);
        return details;
    }
    selectTask(editor, value) {
        const updated = toggleSummaryTask(this.doc.text_fields.summary, value);
        this.doc.text_fields.summary = updated;
        editor.replaceChildren(...runsFromText(updated).map(run => this.runElement(run, editor, () => {})));
        editor.savedRange = null;
        this.commit(); editor.focus();
    }
    trackEditorHeight(editor, key) {
        const saved = Number(this.doc.ui.editor_heights?.[key]);
        if (Number.isFinite(saved) && saved >= 180) editor.style.height = `${saved}px`;
        editor.dataset.heightKey = key;
        this.editorResizeObserver ||= new ResizeObserver(entries => {
            let changed = false;
            for (const { target } of entries) {
                if (!target.isConnected || !target.offsetHeight || !target.style.height) continue;
                const height = Number.parseFloat(target.style.height);
                const key = target.dataset.heightKey;
                if (!Number.isFinite(height) || height < 180 || this.doc.ui.editor_heights?.[key] === height) continue;
                this.doc.ui.editor_heights = { ...this.doc.ui.editor_heights, [key]: height };
                changed = true;
            }
            if (changed) this.onChange(JSON.stringify(this.doc));
        });
        this.editorResizeObserver.observe(editor);
    }
    openNativeReferences(editor, start = editor.selectionStart, end = editor.selectionEnd, query = "") {
        this.openReferenceMenu(editor, item => {
            if (!editor.isConnected || !item.formal) return;
            const scroll = editor.scrollTop;
            editor.setRangeText(item.formal + " ", start, end, "end");
            editor.focus(); editor.scrollTop = scroll;
            this.insertingCommand = true;
            try { editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })); }
            finally { this.insertingCommand = false; }
        }, query, "media", this.nativeCaretAnchor(editor));
    }
    nativeCaretAnchor(editor) {
        const mirror = element("div");
        const style = getComputedStyle(editor);
        for (const key of ["boxSizing", "fontFamily", "fontSize", "fontWeight", "fontStyle",
            "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
            "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "tabSize"]) {
            mirror.style[key] = style[key];
        }
        Object.assign(mirror.style, { position: "fixed", left: "-10000px", top: "0",
            width: `${editor.offsetWidth}px`, height: `${editor.offsetHeight}px`, borderStyle: "solid",
            whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "auto", visibility: "hidden" });
        mirror.textContent = editor.value.slice(0, editor.selectionStart);
        const caret = element("span", "", editor.value.slice(editor.selectionStart) || ".");
        mirror.append(caret); document.body.append(mirror);
        mirror.scrollTop = editor.scrollTop; mirror.scrollLeft = editor.scrollLeft;
        const rect = editor.getBoundingClientRect(), bounds = mirror.getBoundingClientRect();
        const point = caret.getClientRects()[0] || caret.getBoundingClientRect();
        const scale = rect.width / editor.offsetWidth;
        const anchor = { left: rect.left + (point.left - bounds.left) * scale,
            top: rect.top + (point.top - bounds.top) * scale,
            bottom: rect.top + (point.bottom - bounds.top) * scale };
        mirror.remove();
        return anchor;
    }
    suggestNative(editor) {
        const end = editor.selectionStart;
        const match = editor.selectionStart === editor.selectionEnd
            && editor.value.slice(0, end).match(/@([^@\n<>【】{}]{0,30})$/u);
        if (!match) { this.closeReferenceMenu(); return; }
        this.openNativeReferences(editor, end - match[0].length, end, match[1]);
    }
    dispose() {
        this.editorResizeObserver?.disconnect();
        super.dispose();
    }
    render() {
        const scroll = this.body?.scrollTop || 0;
        this.editorResizeObserver?.disconnect();
        this.hideHint(); this.closeReferenceMenu();
        this.root.replaceChildren();
        this.topbar = element("div", "h3p-topbar");
        const identity = element("div", "h3p-identity");
        identity.append(glyph("pencil"), element("h3", "", "H3 提示词编写器"));
        this.topbar.append(identity);
        this.modes = element("div", "h3p-modes"); this.modes.dataset.mode = this.doc.mode;
        for (const [mode, name] of [["compose", "编排模式"], ["native", "原生输入"]]) {
            const control = button(name, () => this.switchMode(mode), mode === "compose" ? "sliders-h" : "align-left");
            control.classList.toggle("h3p-active", this.doc.mode === mode);
            control.setAttribute("aria-pressed", String(this.doc.mode === mode));
            this.modes.append(control);
        }
        const history = element("div", "h3p-row");
        for (const [name, action] of [["撤销", () => this.undo()], ["重做", () => this.redo()]]) {
            const control = button(name, action, "undo"); control.title = name; control.setAttribute("aria-label", name);
            if (name === "重做") control.querySelector("i").style.transform = "scaleX(-1)";
            history.append(control);
        }
        const reset = button("重置", () => this.resetDraft(), "eraser");
        reset.setAttribute("aria-label", "重置");
        reset.dataset.tooltip = "清空提示词并恢复初始模板、10秒时长和1个镜头；保留载入素材，可撤销。";
        history.append(reset);
        this.topbar.append(this.modes, history);
        const parameters = element("div", "h3p-global-inputs");
        this.planningInput(parameters, "视频时长（秒）", () => this.doc.duration_ms / 1000,
            0.1, 600, 0.1, value => { this.doc.duration_ms = Math.round(value * 1000); });
        this.topbar.append(parameters); this.root.append(this.topbar);
        this.status = element("div", "h3p-status"); this.status.setAttribute("role", "status");
        this.body = element("div", "h3p-body");
        this.root.append(this.status, this.body);
        this.renderAssets(this.body);
        this.editors = new Map();
        if (!this.doc.text_fields) {
            this.setStatus("正在读取旧草稿…");
            return;
        }
        if (this.doc.mode === "native") {
            if (!this.doc.ui.native_template_initialized) {
                if (!this.doc.native_text.trim())
                    this.doc.native_text = joinFields(Object.fromEntries(FIELDS.map(key => [key, ""])));
                this.doc.ui.native_template_initialized = true;
                this.onChange(JSON.stringify(this.doc));
            }
            const native = element("textarea", "h3p-native h3p-native-full");
            const nativeTitle = element("div", "h3p-text-title");
            nativeTitle.append(glyph("align-left", "h3p-title-icon"), element("h3", "", "原生提示词"));
            this.body.append(nativeTitle, fieldGuidance("native"));
            native.value = this.doc.native_text; native.spellcheck = false;
            native.setAttribute("aria-label", "原生提示词");
            native.addEventListener("input", event => {
                this.doc.native_text = native.value; this.commit("native_text");
                if (!event.isComposing) this.suggestNative(native);
            });
            native.addEventListener("compositionend", () => this.suggestNative(native));
            native.addEventListener("keydown", event => { if (event.key === "Escape") this.closeReferenceMenu(); });
            this.trackEditorHeight(native, "native");
            const tools = element("div", "h3p-editor-tools");
            const reference = button("引用素材", () => this.openNativeReferences(native), "at");
            reference.title = "插入已激活图片、视频或音频的正式标签。";
            tools.append(reference);
            this.body.append(native, tools);
        } else this.renderTextFields();
        this.issuesArea = element("div", "h3p-issues");
        this.body.append(this.issuesArea);
        this.body.scrollTop = scroll;
        this.renderResults();
    }
    planningInput(parent, name, read, min, max, step, change) {
            const label = element("label", "h3p-field");
            const control = element("input", "h3p-input"); control.type = "number";
            control.min = String(min); control.max = String(max); control.step = String(step);
            control.value = String(read()); control.setAttribute("aria-label", name);
            control.addEventListener("change", () => {
                const number = Number(control.value);
                if (!control.value || !control.validity.valid || !Number.isFinite(number)) {
                    control.value = String(read());
                    return;
                }
                change(number); this.commit("planning." + name);
            });
            label.append(element("span", "", name), control); parent.append(label);
    }
    renderTextFields() {
        const tabs = element("div", "h3p-field-tabs");
        tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "提示词分区");
        const views = [];
        for (const [index, key] of FIELDS.entries()) {
            const tab = button(FIELD_NAMES[index], () => activate(key), FIELD_ICONS[index]);
            tab.setAttribute("role", "tab"); tab.id = `h3p-tab-${this.node.id}-${key}`;
            const view = element("section", "h3p-text-section"); view.dataset.field = key;
            view.setAttribute("role", "tabpanel"); view.setAttribute("aria-labelledby", tab.id);
            view.id = `h3p-view-${this.node.id}-${key}`; tab.setAttribute("aria-controls", view.id);
            const title = element("div", "h3p-text-title");
            title.append(glyph(FIELD_ICONS[index], "h3p-title-icon"),
                element("h3", "", FIELD_NAMES[index]), element("small", "h3p-official-field", key));
            const toolbar = element("div", "h3p-row h3p-text-tools");
            const editorHost = element("div", "h3p-text-host");
            const editor = this.richEditor(editorHost, runsFromText(this.doc.text_fields[key]), runs => {
                this.doc.text_fields[key] = textFromRuns(runs);
            }, key, false);
            editor.classList.add("h3p-section-editor");
            this.trackEditorHeight(editor, key);
            this.editors.set(key, editor);
            for (const name of ["keyup", "pointerup", "focusout", "input"]) {
                editor.addEventListener(name, () => {
                    this.captureRange(editor);
                    if (name !== "focusout" && !this.insertingCommand) editor.pendingPreset = false;
                });
            }
            editor.addEventListener("keydown", event => {
                if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.isComposing) {
                    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
                    const slots = [];
                    while (walker.nextNode()) {
                        if (walker.currentNode.parentElement.closest("[contenteditable=false]")) continue;
                        for (const match of walker.currentNode.textContent.matchAll(/【[^】]*】/g)) {
                            const range = document.createRange();
                            range.setStart(walker.currentNode, match.index);
                            range.setEnd(walker.currentNode, match.index + match[0].length);
                            slots.push(range);
                        }
                    }
                    const selection = window.getSelection();
                    const current = slots.findIndex(range => selection.rangeCount &&
                        range.compareBoundaryPoints(Range.START_TO_START, selection.getRangeAt(0)) === 0);
                    const next = slots[current + (event.shiftKey ? -1 : 1)];
                    if (next) {
                        event.preventDefault(); selection.removeAllRanges(); selection.addRange(next);
                        editor.savedRange = next.cloneRange();
                    }
                }
            });
            const insert = text => {
                const expanded = expandPreset(text, this.doc.text_fields);
                if (key !== "summary") return this.insertText(editor, expanded, true);
                const preset = summaryParts(expanded);
                this.insertText(editor, preset.body, true);
                for (const task of preset.tasks) {
                    if (!summaryParts(this.doc.text_fields.summary).tasks.includes(task)) this.selectTask(editor, task);
                }
            };
            if (key === "summary") {
                const overview = button("目标概述", () => insert(summaryPreset(this.doc.text_fields.summary)));
                overview.dataset.summaryOverview = "true";
                overview.title = "填写视频的整体目标";
                toolbar.append(overview, button("添加参考用途", () => {
                    editor.savedRange = null;
                    insert(SUMMARY_REFERENCE_PRESET);
                }));
            }
            else if (key === "subject_definitions" || key === "detailed_description") {
                const presets = new Map(PRESETS[key]);
                const groups = key === "subject_definitions" ? REFERENCE_PRESET_GROUPS : DETAILED_PRESET_GROUPS;
                for (const { title, hint, labels, markers } of groups) {
                    const group = element("div", "h3p-preset-group");
                    group.setAttribute("role", "group"); group.setAttribute("aria-label", title);
                    const heading = element("div", "h3p-preset-heading");
                    const groupIcon = /音|声|白/.test(title) ? "volume-up"
                        : /视频|镜头/.test(title) ? "video"
                        : /图/.test(title) ? "image" : /格式|文字/.test(title) ? "code" : "bookmark";
                    const label = element("strong", "", title);
                    label.prepend(glyph(groupIcon));
                    heading.append(label, element("span", "h3p-note", hint));
                    const actions = element("div", "h3p-row");
                    if (key === "detailed_description" && title === "镜头与画面") {
                        this.planningInput(actions, "镜头数量", () => plannedShotCount(this.doc),
                            1, 100, 1, value => { this.doc.ui.shot_count = value; });
                    }
                    for (const label of labels) {
                        const control = button(label, label === "补齐规划镜头" ? () => this.completePlannedShots()
                            : label === "整体画风" ? () => this.insertOverallStyle(editor) : () => insert(presets.get(label)));
                        if (label === "整体画风") control.dataset.overallStyle = "true";
                        actions.append(control);
                    }
                    if (markers) this.menu(actions, "格式标记", MARKERS, value => this.insertText(editor, value));
                    group.append(heading, actions); toolbar.append(group);
                }
            } else for (const [label, text] of PRESETS[key]) toolbar.append(button(label, () => insert(text)));
            const optionGroup = (title, options, choose, tasks = false) => {
                const group = element("div", "h3p-row h3p-option-group");
                group.setAttribute("role", "group"); group.setAttribute("aria-label", title);
                group.append(element("span", "h3p-label", title));
                for (const [label, value] of options) {
                    const control = button(label, () => choose(value));
                    if (tasks) control.dataset.task = value;
                    group.append(control);
                }
                toolbar.append(group);
            };
            if (key === "summary") optionGroup("任务类型", TASK_TYPES, value => this.selectTask(editor, value), true);
            view.append(title, fieldGuidance(key), toolbar, editorHost); views.push({ key, tab, view });
            tabs.append(tab);
        }
        const activate = key => {
            this.closeReferenceMenu();
            this.doc.ui.active_field = key;
            for (const item of views) {
                const active = item.key === key;
                item.view.hidden = !active;
                item.tab.classList.toggle("h3p-active", active);
                item.tab.setAttribute("aria-selected", String(active));
                item.tab.tabIndex = active ? 0 : -1;
            }
            this.onChange(JSON.stringify(this.doc));
        };
        tabs.addEventListener("keydown", event => {
            const index = FIELDS.indexOf(this.doc.ui.active_field);
            const offset = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
            if (offset) {
                event.preventDefault();
                const next = (index + offset + FIELDS.length) % FIELDS.length;
                activate(FIELDS[next]); views[next].tab.focus();
            }
        });
        this.body.append(tabs, ...views.map(item => item.view));
        this.refreshTaskButtons();
        activate(FIELDS.includes(this.doc.ui.active_field) ? this.doc.ui.active_field : FIELDS[0]);
    }
    completePlannedShots() {
        const editor = this.editors.get("detailed_description");
        if (!editor) return;
        const current = this.doc.text_fields.detailed_description;
        const updated = completeShotOutline(current, plannedShotCount(this.doc));
        if (updated === current) return;
        editor.replaceChildren(...runsFromText(updated).map(run => this.runElement(run, editor, () => {})));
        editor.savedRange = null;
        this.doc.text_fields.detailed_description = updated;
        this.commit();
    }
    renderResults() {
        if (!this.issuesArea || !this.lastCompiled) return;
        const issues = this.lastCompiled.issues || [];
        const errors = issues.filter(row => row.level === "error").length;
        this.setStatus([this.importNotice, `${errors} 个错误，${issues.length - errors} 条提醒`].filter(Boolean).join(" "), errors > 0);
        this.issuesArea.replaceChildren();
        for (const row of issues) {
            const field = String(row.path || "").split(".")[0];
            const index = FIELDS.indexOf(field);
            const name = index >= 0 ? FIELD_NAMES[index] : field === "assets" ? "素材"
                : this.doc.mode === "native" ? "原生输入" : "提示词";
            const message = row.message === "此区还有待填写内容。" ? "还有待填写内容。" : row.message;
            const control = button(`【${name}】${message}`, () => {
                if (this.doc.mode === "compose" && index >= 0) {
                    this.body.querySelector(`[aria-controls="h3p-view-${this.node.id}-${field}"]`)?.click();
                    const editor = this.editors.get(field);
                    editor?.focus({ preventScroll: true });
                    editor?.scrollIntoView({ block: "nearest" });
                } else if (this.doc.mode === "native") {
                    this.body.querySelector(".h3p-native-full")?.focus();
                }
            });
            if (index >= 0) control.title = `前往${name}`;
            control.classList.add(row.level === "error" ? "h3p-error" : "h3p-warning");
            this.issuesArea.append(control);
        }
    }
}
