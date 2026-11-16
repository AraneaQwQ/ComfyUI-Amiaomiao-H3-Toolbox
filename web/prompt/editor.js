import { clone, uid, defaultDocument, parseDocument, addShot, removeShot, moveShot, shotLabels,
    mergeAssets, selectorsFromGraph, directSlot, mcCandidates, runsFromText, textFromRuns, createHistory, FIELDS } from "./state.js";
import { VISUAL, AUDIO, TASKS, PURPOSES, LANGUAGES, DELIVERY, HELP } from "./catalog.js";

const el = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
};
function button(label, icon, action, title = label) {
    const control = el("button", "h3p-button");
    control.type = "button"; control.title = title; control.setAttribute("aria-label", title);
    if (!label) { control.dataset.tooltip = title; control.removeAttribute("title"); }
    if (icon) { const glyph = el("i", `pi pi-${icon}`); glyph.setAttribute("aria-hidden", "true"); control.append(glyph); }
    if (label) control.append(document.createTextNode(label));
    control.addEventListener("click", action);
    return control;
}
function select(options, value, change, label) {
    const control = el("select", "h3p-select");
    control.setAttribute("aria-label", label);
    for (const item of options) {
        const [id, name] = Array.isArray(item) ? item : [item.value, item.label];
        const option = el("option", "", name); option.value = id; control.append(option);
    }
    if (![...control.options].some(o => o.value === String(value ?? "")) && value) {
        const missing = el("option", "", "已失效 · " + value); missing.value = value; control.append(missing);
    }
    control.value = value ?? "";
    control.addEventListener("change", () => change(control.value));
    return control;
}
function field(parent, name, control, path) {
    const wrapper = el("label", "h3p-field");
    wrapper.append(el("span", "h3p-label", name), control);
    if (path) wrapper.dataset.path = path;
    parent.append(wrapper); return wrapper;
}
function input(value, change, name, type = "text") {
    const control = el("input", "h3p-input");
    control.type = type; control.value = value ?? ""; control.setAttribute("aria-label", name);
    if (type === "number") { control.step = "0.001"; control.min = "0"; }
    control.addEventListener("input", () => change(type === "number" ? (
        control.value === "" ? null : Number(control.value)) : control.value));
    return control;
}
function checkbox(name, value, change) {
    const label = el("label", "h3p-check"), control = el("input");
    control.type = "checkbox"; control.checked = !!value;
    control.addEventListener("change", () => change(control.checked));
    label.append(control, document.createTextNode(name)); return label;
}
const plainText = node => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeName === "BR") return "\n";
    const content = [...node.childNodes].map(plainText).join("");
    return node.nodeName === "DIV" || node.nodeName === "P" ? content + "\n" : content;
};
const flatten = (parent, output = []) => {
    for (const child of parent.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && child.dataset.h3Run) {
            const run = clone(child.h3Run);
            const text = child.querySelector("[data-run-text]");
            if (text) run.text = plainText(text).replace(/\n$/, "");
            output.push(run);
        } else if (child.nodeType === Node.TEXT_NODE) {
            output.push({ kind: "text", text: child.textContent });
        } else if (child.nodeName === "BR") output.push({ kind: "text", text: "\n" });
        else {
            flatten(child, output);
            if (["DIV", "P"].includes(child.nodeName)) output.push({ kind: "text", text: "\n" });
        }
    }
    return output;
};

export class ComposerPanel {
    constructor({ node, api, graph, value, onChange }) {
        this.node = node; this.api = api; this.graph = graph; this.onChange = onChange;
        this.root = el("div", "h3p-root");
        this.root.setAttribute("aria-label", "H3 提示词编排器");
        this.lifetime = new AbortController(); this.version = 0; this.disposed = false;
        for (const name of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "keydown"]) {
            this.root.addEventListener(name, event => event.stopPropagation());
        }
        this.root.addEventListener("keydown", event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.isComposing) {
                event.preventDefault(); event.shiftKey ? this.redo() : this.undo();
            }
        });
        const hintTarget = event => event.target.closest?.("button[data-tooltip]");
        this.root.addEventListener("pointerover", event => {
            const target = hintTarget(event); if (target) this.showHint(target);
        });
        this.root.addEventListener("pointerout", event => {
            if (this.hintControl && !this.hintControl.contains(event.relatedTarget)) this.hideHint();
        });
        this.root.addEventListener("focusin", event => {
            const target = hintTarget(event); if (target) this.showHint(target);
        });
        for (const name of ["focusout", "pointerdown", "keydown", "scroll"]) {
            this.root.addEventListener(name, () => this.hideHint(), true);
        }
        this.load(value || JSON.stringify(defaultDocument()));
    }
    showHint(control) {
        if (this.hintControl === control) return;
        this.hideHint(); this.hintControl = control;
        this.hintTimer = setTimeout(() => {
            if (!control.isConnected || this.disposed || !control.dataset.tooltip) return;
            const hint = el("div", "h3p-tooltip", control.dataset.tooltip);
            hint.id = uid("h3-hint"); hint.setAttribute("role", "tooltip");
            document.body.append(hint); this.hint = hint;
            control.setAttribute("aria-describedby", hint.id);
            const anchor = control.getBoundingClientRect(), bounds = hint.getBoundingClientRect();
            hint.style.left = Math.max(8, Math.min(anchor.left + (anchor.width - bounds.width) / 2,
                window.innerWidth - bounds.width - 8)) + "px";
            hint.style.top = (anchor.top > bounds.height + 12 ? anchor.top - bounds.height - 6 : anchor.bottom + 6) + "px";
        }, 350);
    }
    hideHint() {
        clearTimeout(this.hintTimer);
        this.hintControl?.removeAttribute("aria-describedby");
        this.hintControl = null; this.hint?.remove(); this.hint = null;
    }
    reveal(element) {
        element.getAnimations().forEach(animation => animation.cancel());
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        element.animate([
            { opacity: 0.65, clipPath: "inset(0 0 8px 0)", transform: "translateY(-3px)" },
            { opacity: 1, clipPath: "inset(0)", transform: "translateY(0)" },
        ], { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    }
    load(raw) {
        try {
            this.doc = parseDocument(raw); this.history = createHistory(this.doc);
            this.lastCompiled = null; this.version++; this.render(); this.scheduleCompile();
        } catch (error) {
            this.root.replaceChildren(el("p", "h3p-error", "草稿读取失败，原文仍保留：" + error.message));
        }
    }
    commit(key) {
        this.version++; this.history.record(this.doc, key);
        this.onChange(JSON.stringify(this.doc)); this.refreshLabels(); this.scheduleCompile();
    }
    structural(action) { action(); this.commit(); this.render(); }
    undo() { const doc = this.history.undo(this.doc); if (doc) { this.doc = doc; this.persistHistory(); } }
    redo() { const doc = this.history.redo(this.doc); if (doc) { this.doc = doc; this.persistHistory(); } }
    persistHistory() {
        this.version++; this.onChange(JSON.stringify(this.doc)); this.render(); this.scheduleCompile();
    }
    scheduleCompile() {
        clearTimeout(this.compileTimer);
        this.setStatus("正在编排…");
        this.compileTimer = setTimeout(() => this.compileNow(), 300);
    }
    setStatus(text, error = false) {
        if (this.status) { this.status.textContent = text; this.status.classList.toggle("h3p-error", error); }
    }
    async post(path, body) {
        const response = await this.api.fetchApi("/amiaomiao_h3/prompt/" + path, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), signal: this.lifetime.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `请求失败 ${response.status}`);
        return result;
    }
    async compileNow() {
        clearTimeout(this.compileTimer);
        const version = this.version;
        try {
            const result = await this.post("compile", { document: this.doc });
            if (version !== this.version || this.disposed) return null;
            this.lastCompiled = result; this.compiledVersion = version; this.renderResults();
            return result;
        } catch (error) {
            if (!this.disposed && version === this.version) this.setStatus(error.message, true);
            return null;
        }
    }
    section(title, key, parent, open = true) {
        const section = el("section", "h3p-section"), heading = el("div", "h3p-section-heading");
        section.dataset.sectionKey = key;
        heading.append(el("h3", "", title));
        const help = HELP[key];
        const body = el("div", "h3p-section-body");
        if (help) {
            const details = el("details", "h3p-help");
            details.open = this.helpOpen?.get(key) ?? false;
            const toggle = el("summary", "", "写法与示例");
            details.append(toggle);
            for (const [index, text] of help.entries()) details.append(el("p", "", ["这里写什么：", "示例（未绑定）：", "常见错误："][index] + text));
            details.append(button("复制示例", "copy", () => this.copy(help[1])));
            heading.append(details);
        }
        section.append(heading, body); parent.append(section);
        if (!open) body.hidden = true;
        return { section, heading, body };
    }
    optionField(parent, name, options, value, change) {
        const wrapper = el("div", "h3p-option-field");
        const description = el("div", "h3p-option-description");
        const details = el("details", "h3p-option-help");
        details.append(el("summary", "", "详细说明"));
        const full = el("p"); details.append(full);
        const update = current => {
            const item = options.find(o => o.value === current);
            description.textContent = item?.short || ""; full.textContent = item?.detail || "";
        };
        field(wrapper, name, select(options, value, selected => { update(selected); change(selected); }, name));
        update(value); wrapper.append(description, details); parent.append(wrapper);
        return wrapper;
    }
    shortText(parent, name, value, change, path) {
        return field(parent, name, input(value, v => { change(v); this.commit(path || name); }, name), path);
    }
    seconds(parent, name, milliseconds, change, path, disabled = false) {
        const control = input(milliseconds == null ? null : milliseconds / 1000,
            seconds => { change(seconds == null ? null : Math.round(seconds * 1000)); this.commit(path || name); }, name, "number");
        control.disabled = disabled; control.placeholder = "待填写";
        return field(parent, name, control, path);
    }
    textEditor(parent, label, value, change, path) {
        const wrapper = el("div", "h3p-field"); wrapper.dataset.path = path || label;
        wrapper.append(el("span", "h3p-label", label));
        this.richEditor(wrapper, runsFromText(value || ""), runs => change(textFromRuns(runs)), path || label, false);
        parent.append(wrapper); return wrapper;
    }
    speakers() {
        return [["", "待选发声者"], ...this.doc.definitions.filter(d => d.kind === "Subject").map(d => [d.id, d.name || "未命名对象"]),
            ["narrator", "独立旁白"]];
    }
    runElement(run, editor, save) {
        if (run.kind === "text") return document.createTextNode(run.text);
        const chip = el("span", "h3p-inline"); chip.contentEditable = "false";
        chip.dataset.h3Run = "true"; chip.h3Run = clone(run);
        if (run.kind === "ref") {
            chip.classList.add("h3p-reference"); chip.dataset.refTarget = run.target || "ref"; chip.dataset.refId = run.id;
            this.fillReference(chip);
            chip.addEventListener("click", () => {
                const asset = this.doc.assets.find(a => a.id === run.id);
                if (asset) this.previewAsset(asset);
            });
            return chip;
        }
        if (run.kind === "event") {
            chip.classList.add("h3p-event");
            const time = input(run.start_ms == null ? null : run.start_ms / 1000, seconds => {
                chip.h3Run.start_ms = seconds == null ? null : Math.round(seconds * 1000); save();
            }, "镜头内时间点（秒）", "number");
            time.title = "本段时间（秒），不吸附帧"; chip.append(time, document.createTextNode("秒 "));
        } else if (run.kind === "dialogue") {
            chip.classList.add("h3p-dialogue");
            const row = el("span", "h3p-inline-controls");
            const badge = el("span", "h3p-speaker-badge", "S?");
            badge.dataset.speakerId = run.speaker || ""; row.append(badge);
            row.append(select(this.speakers(), run.speaker, value => {
                chip.h3Run.speaker = value; badge.dataset.speakerId = value;
                narrator.hidden = value !== "narrator"; save();
            }, "发声者"));
            row.append(select(LANGUAGES, run.language, value => {
                chip.h3Run.language = value; this.lastLanguage = value; save();
            }, "台词语言"));
            const settings = el("details", "h3p-dialogue-settings"), toggle = el("summary", "", "发声设置");
            const settingsBody = el("span", "h3p-dialogue-options"); settings.append(toggle, settingsBody);
            const time = input(run.start_ms == null ? null : run.start_ms / 1000, seconds => {
                chip.h3Run.start_ms = seconds == null ? null : Math.round(seconds * 1000); save();
            }, "发声开始时间（秒）", "number");
            field(settingsBody, "本段开始时间（秒）", time);
            field(settingsBody, "发声形式", select(DELIVERY, run.delivery || "says", v => { chip.h3Run.delivery = v; save(); }, "发声形式"));
            field(settingsBody, "语气", input(run.mood, v => { chip.h3Run.mood = v; save(); }, "语气"));
            field(settingsBody, "重音", input(run.emphasis, v => { chip.h3Run.emphasis = v; save(); }, "重音"));
            const narrator = field(settingsBody, "旁白声音描述", input(run.voice_description, v => {
                chip.h3Run.voice_description = v; save();
            }, "旁白声音描述"));
            narrator.hidden = run.speaker !== "narrator"; row.append(settings); chip.append(row);
        }
        const content = el("span", "h3p-inline-text", run.text || "");
        content.contentEditable = "true"; content.dataset.runText = "true";
        content.setAttribute("role", "textbox");
        content.setAttribute("aria-label", run.kind === "dialogue" ? "行内台词" : "时间点内容");
        content.addEventListener("keydown", event => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault(); event.stopPropagation();
                const tail = document.createTextNode(" "); chip.after(tail);
                const range = document.createRange(); range.setStart(tail, 1); range.collapse(true);
                const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
                editor.focus(); save();
            }
        });
        chip.append(content); return chip;
    }
    fillReference(chip) {
        const identity = chip.dataset.refId, isDefinition = chip.dataset.refTarget === "def";
        const item = (isDefinition ? this.doc.definitions : this.doc.assets).find(a => a.id === identity);
        chip.replaceChildren();
        if (item?.thumbnail_url) {
            const image = el("img"); image.src = item.thumbnail_url; image.alt = ""; image.loading = "lazy"; chip.append(image);
        }
        chip.append(document.createTextNode("@" + (item?.alias || item?.label || item?.name || "失效引用")));
        chip.classList.toggle("h3p-invalid", !item || !!item.missing || !!item.skip);
        chip.title = item?.source || (isDefinition ? "已定义对象" : "来源已失效");
    }
    richEditor(parent, runs, change, path, dialogue = true, carry = false) {
        const editor = el("div", "h3p-editor"); editor.contentEditable = "true";
        editor.setAttribute("role", "textbox"); editor.setAttribute("aria-multiline", "true");
        editor.setAttribute("aria-label", path); editor.dataset.path = path;
        const save = () => { change(flatten(editor)); this.commit(path); };
        for (const run of runs || []) editor.append(this.runElement(run, editor, save));
        let lastRange = null;
        const remember = () => {
            const selection = window.getSelection();
            if (selection.rangeCount && editor.contains(selection.anchorNode)) lastRange = selection.getRangeAt(0).cloneRange();
        };
        for (const event of ["keyup", "pointerup", "focusout"]) editor.addEventListener(event, remember);
        editor.addEventListener("input", event => {
            remember(); save(); if (!event.isComposing) this.suggest(editor, save);
        });
        editor.addEventListener("compositionend", () => { remember(); save(); this.suggest(editor, save); });
        editor.addEventListener("paste", event => {
            event.preventDefault();
            const selection = window.getSelection();
            if (!selection.rangeCount) return;
            const range = selection.getRangeAt(0); range.deleteContents();
            const node = document.createTextNode(event.clipboardData.getData("text/plain"));
            range.insertNode(node); range.setStartAfter(node); range.collapse(true);
            selection.removeAllRanges(); selection.addRange(range); save();
        });
        const insert = run => {
            editor.focus();
            const range = lastRange && editor.contains(lastRange.startContainer) ? lastRange.cloneRange() : document.createRange();
            if (!lastRange || !editor.contains(range.startContainer)) { range.selectNodeContents(editor); range.collapse(false); }
            range.deleteContents();
            const node = this.runElement(run, editor, save); range.insertNode(node);
            const tail = document.createTextNode(" "); node.after(tail);
            range.setStart(tail, 1); range.collapse(true);
            const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
            lastRange = range.cloneRange(); save();
            node.querySelector?.("[data-run-text]")?.focus();
        };
        const tools = el("div", "h3p-editor-tools");
        if (dialogue) {
            const speech = button("插入台词", "comment", () => insert({
                kind: "dialogue", id: uid("line"), speaker: "", language: this.lastLanguage || "",
                text: "", start_ms: null, delivery: "says", mood: "", emphasis: "",
            }));
            speech.disabled = carry; speech.title = carry ? "承接裁切区不能安排台词" : "在上次光标位置插入台词";
            tools.append(speech, button("插入时间点", "clock", () => insert({ kind: "event", start_ms: null, text: "" })));
        }
        tools.append(button("引用素材或定义", "at", () => this.openReferenceMenu(editor, item => insert({
            kind: "ref", target: item.target, id: item.id,
        }))));
        parent.append(editor, tools); return editor;
    }
    suggest(editor, save) {
        const selection = window.getSelection(), anchor = selection.anchorNode;
        if (!anchor || anchor.nodeType !== Node.TEXT_NODE || !editor.contains(anchor) || anchor.parentElement.closest("[data-run-text]")) return;
        const before = anchor.textContent.slice(0, selection.anchorOffset), match = before.match(/@([^@\n{}]{0,30})$/u);
        if (!match) { this.closeReferenceMenu(); return; }
        const start = selection.anchorOffset - match[0].length, end = selection.anchorOffset;
        this.openReferenceMenu(editor, item => {
            const range = document.createRange(); range.setStart(anchor, start); range.setEnd(anchor, end); range.deleteContents();
            const node = this.runElement({ kind: "ref", target: item.target, id: item.id }, editor, save);
            range.insertNode(node); range.setStartAfter(node); range.collapse(true);
            selection.removeAllRanges(); selection.addRange(range); editor.focus(); save();
        }, match[1]);
    }
    closeReferenceMenu() { this.referenceMenu?.remove(); this.referenceMenu = null; }
    openReferenceMenu(editor, insert, query = "", assetsOnly = false) {
        this.closeReferenceMenu();
        const popup = el("div", "h3p-root h3p-reference-menu");
        popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", "选择引用");
        const search = input(query, value => list(value), "搜索素材或定义");
        const results = el("div", "h3p-reference-results");
        popup.append(search, results, button("关闭", "times", () => this.closeReferenceMenu()));
        const activeAssets = this.doc.assets.filter(asset => !asset.skip && !asset.missing);
        const activeIds = new Set(activeAssets.map(asset => asset.id));
        const items = [
            ...(assetsOnly ? [] : this.doc.definitions.filter(definition =>
                definition.sources.every(source => activeIds.has(source.asset_id)))
                .map(d => ({ ...d, target: "def", label: d.name, source: "已定义对象" }))),
            ...activeAssets.map(a => ({ ...a, target: "ref", label: a.alias || a.label })),
        ];
        const list = filter => {
            results.replaceChildren();
            const visible = items.filter(item => `${item.label} ${item.source}`.toLowerCase().includes(filter.toLowerCase()));
            for (const item of visible) {
                const control = button("", null, () => { this.closeReferenceMenu(); insert(item); }, "引用 " + item.label);
                control.classList.add("h3p-reference-choice");
                if (item.thumbnail_url) {
                    const image = el("img"); image.src = item.thumbnail_url; image.alt = item.label; image.loading = "lazy"; control.append(image);
                }
                const text = el("span"); text.append(el("strong", "", "@" + (item.label || "未命名")),
                    el("small", "", (item.target === "def" ? "定义" : { image: "图片", audio: "音频", video: "视频" }[item.kind]) + " · " + item.source));
                control.append(text); control.disabled = !!item.missing || !!item.skip; results.append(control);
            }
            if (!visible.length) results.append(el("p", "h3p-note", "没有匹配的引用。"));
        };
        list(query);
        popup.addEventListener("pointerdown", event => { if (event.target.closest(".h3p-reference-choice")) event.preventDefault(); });
        document.body.append(popup); this.referenceMenu = popup;
        const rect = editor.getBoundingClientRect();
        popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 340))}px`;
        popup.style.top = `${Math.max(8, Math.min(rect.bottom, window.innerHeight - 340))}px`;
        popup.addEventListener("keydown", event => { if (event.key === "Escape") this.closeReferenceMenu(); event.stopPropagation(); });
    }
    refreshLabels() {
        for (const chip of this.root.querySelectorAll("[data-ref-id]")) this.fillReference(chip);
    }
    async refreshAssets() {
        this.refreshButton.disabled = true; this.setStatus("正在读取素材记录…");
        try {
            const { selectors, errors } = selectorsFromGraph(this.graph?._nodes || []);
            const response = await this.post("assets", { selectors });
            for (const asset of response.assets) {
                if (asset.slot == null && this.graph) asset.slot = directSlot(asset, this.graph);
            }
            const merged = mergeAssets(this.doc.assets, response.assets);
            this.doc.assets = merged.assets;
            this.assetNotice = `新增 ${merged.added}，更新 ${merged.updated}，失效或跳过 ${merged.missing}`;
            this.assetErrors = [...errors, ...response.errors.map(row => `${row.node_id}：${row.message}`)];
            this.structural(() => {});
        } catch (error) { this.setStatus(error.message, true); }
        finally { if (this.refreshButton) this.refreshButton.disabled = false; }
    }
    previewAsset(asset) {
        this.previewDialog?.remove();
        const dialog = el("dialog", "h3p-root h3p-media-dialog");
        dialog.append(el("h3", "", asset.alias || asset.label));
        const url = asset.preview_url || asset.thumbnail_url;
        if (url) {
            const tag = asset.kind === "audio" ? "audio" : asset.kind === "video" && asset.preview_url ? "video" : "img";
            const media = el(tag); media.src = url; media.alt = asset.label;
            if (tag !== "img") {
                media.controls = true; media.preload = "metadata";
                if (asset.kind === "audio") {
                    media.addEventListener("loadedmetadata", () => { media.currentTime = Number(asset.start) || 0; });
                    media.addEventListener("timeupdate", () => {
                        if (asset.duration > 0 && media.currentTime >= Number(asset.start || 0) + Number(asset.duration)) {
                            media.pause(); media.currentTime = Number(asset.start) || 0;
                        }
                    });
                }
            }
            dialog.append(media);
        } else dialog.append(el("p", "", "该归档没有可用播放文件或预览。"));
        const close = () => { dialog.querySelectorAll("audio,video").forEach(m => m.pause()); dialog.close(); dialog.remove(); };
        dialog.append(button("关闭", "times", close));
        dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
        document.body.append(dialog); dialog.showModal(); this.previewDialog = dialog;
    }
    renderAssets(parent) {
        const { heading, body } = this.section("素材", "assets", parent);
        heading.classList.add("h3p-assets-heading");
        const disclosure = (name, target, collapsed, change, primary = false) => {
            const control = button("", null, () => {
                collapsed = !collapsed; change(collapsed); update();
                if (!collapsed) this.reveal(target);
                else target.getAnimations().forEach(animation => animation.cancel());
                this.commit("ui.assets");
            });
            control.classList.add(primary ? "h3p-section-toggle" : "h3p-group-toggle");
            const icon = el("i", "pi"); icon.setAttribute("aria-hidden", "true"); control.append(icon);
            const label = primary ? el("span") : null;
            if (label) control.append(label);
            const update = () => {
                target.hidden = collapsed;
                icon.className = "pi pi-" + (primary ? "chevron-right" : "angle-right");
                if (label) label.textContent = collapsed ? "展开" : "收起";
                const description = (collapsed ? "展开" : "收起") + name;
                if (!primary) control.dataset.tooltip = description;
                control.setAttribute("aria-label", description);
                control.setAttribute("aria-expanded", String(!collapsed));
            };
            update(); return control;
        };
        heading.append(disclosure("素材", body, !!this.doc.ui.assets_collapsed,
            value => { this.doc.ui.assets_collapsed = value; }, true));
        this.refreshButton = button("刷新素材", "refresh", () => this.refreshAssets()); heading.append(this.refreshButton);
        if (this.assetNotice) body.append(el("p", "h3p-note", this.assetNotice));
        if (this.assetErrors?.length) body.append(el("p", "h3p-warning", this.assetErrors.join("\n")));
        const activeAssets = this.doc.assets.filter(asset => !asset.skip && !asset.missing);
        if (!activeAssets.length) body.append(el("p", "h3p-note", "暂无已激活素材。"));
        for (const [kind, label] of [["image", "图片"], ["audio", "音频"], ["video", "视频"]]) {
            const assets = activeAssets.filter(asset => asset.kind === kind);
            if (!assets.length) continue;
            const group = el("section", "h3p-asset-group"); group.dataset.assetKind = kind;
            const title = el("div", "h3p-asset-group-heading"), grid = el("div", "h3p-asset-grid");
            const kindIcon = el("i", "pi pi-" + { image: "image", audio: "volume-up", video: "video" }[kind]);
            kindIcon.setAttribute("aria-hidden", "true");
            title.append(disclosure(label, grid, !!this.doc.ui.asset_groups_collapsed[kind],
                value => { this.doc.ui.asset_groups_collapsed[kind] = value; }),
                kindIcon, el("h4", "", label), el("span", "h3p-note", String(assets.length)));
            group.append(title, grid); body.append(group);
            for (const asset of assets) this.renderAssetCard(asset, grid);
        }
    }
    renderAssetCard(asset, parent) {
            const row = el("article", "h3p-asset-card");
            row.classList.toggle("h3p-invalid", !!asset.missing || !!asset.skip); row.dataset.assetId = asset.id;
            const preview = button("", asset.kind === "audio" ? "volume-up" : "play",
                () => this.previewAsset(asset), "预览 " + asset.label);
            preview.classList.add("h3p-asset-preview");
            if (asset.thumbnail_url) {
                const image = el("img"); image.src = asset.thumbnail_url; image.alt = asset.label; image.loading = "lazy"; preview.prepend(image);
            }
            const name = el("div", "h3p-asset-name");
            name.append(el("strong", "", asset.label), el("small", "", asset.source + (asset.missing ? " · 已失效" : asset.skip ? " · 已跳过" : "")));
            name.title = asset.label + "\n" + asset.source;
            row.append(preview, name);
            const fields = el("div", "h3p-asset-fields"); row.append(fields);
            field(fields, "别名", input(asset.alias, v => { asset.alias = v; this.commit("asset." + asset.id); }, "显示别名"));
            if (asset.mapping_changed) row.append(el("span", "h3p-warning", "接线编号已变化，请重新确认正式编号。"));
            const slot = input(asset.slot, v => {
                asset.slot = v; asset.mapping_changed = false; this.commit("slot." + asset.id);
            }, "正式输入编号", "number");
            slot.step = "1"; slot.min = "1"; slot.max = "99"; slot.placeholder = "待确认";
            field(fields, { image: "Picture", audio: "Audio", video: "Video" }[asset.kind] + " 编号", slot);
            if (asset.kind === "video") {
                row.append(checkbox("使用原音轨", asset.audio_enabled, v => {
                    this.structural(() => { asset.audio_enabled = v; });
                }));
                if (asset.audio_enabled) {
                    const audioSlot = input(asset.audio_slot, v => { asset.audio_slot = v; this.commit("audio-slot." + asset.id); }, "原音轨 Audio 编号", "number");
                    audioSlot.min = "1"; audioSlot.step = "1"; field(row, "原音轨 Audio 编号", audioSlot);
                }
            }
            parent.append(row);
    }
    renderDefinitions(parent) {
        const { body } = this.section("主体定义", "definitions", parent);
        let subjectNumber = 0;
        for (const definition of this.doc.definitions.filter(item => item.kind === "Subject")) {
            const number = ++subjectNumber, entry = el("div", "h3p-definition");
            entry.dataset.definitionId = definition.id;
            const title = el("div", "h3p-entry-heading");
            title.append(el("strong", "", `Subject ${number}`), button("", "trash", () => this.structural(() => {
                this.doc.definitions = this.doc.definitions.filter(item => item.id !== definition.id);
            }), "删除定义（可撤销）"));
            entry.append(title);
            const sources = definition.sources.length ? definition.sources : [{ asset_id: "", role: "" }];
            for (const [index, source] of sources.entries()) {
                const row = el("div", "h3p-row");
                const choices = this.doc.assets.filter(asset =>
                    !asset.skip && !asset.missing && ["image", "video"].includes(asset.kind));
                field(row, index ? `选择素材 ${index + 1}` : "选择素材", select(
                    [["", "选择素材"], ...choices.map(asset => [asset.id, `@${asset.alias || asset.label}${asset.skip || asset.missing ? "（失效）" : ""}`])],
                    choices.some(asset => asset.id === source.asset_id) ? source.asset_id : "", value => this.structural(() => {
                        if (!definition.sources.length) definition.sources.push(source);
                        source.asset_id = value;
                        if (!definition.name) {
                            const asset = this.doc.assets.find(item => item.id === value);
                            definition.name = asset?.alias || asset?.label || "";
                        }
                    }), `Subject ${number} 素材 ${index + 1}`));
                if (index) row.append(button("", "times", () => this.structural(() => definition.sources.splice(index, 1)), "移除此素材"));
                else row.append(button("", "plus", () => this.structural(() => {
                    if (!definition.sources.length) definition.sources.push(sources[0]);
                    definition.sources.push({ asset_id: "", role: "" });
                }), "添加素材"));
                entry.append(row);
                if (source.asset_id && !choices.some(asset => asset.id === source.asset_id)) {
                    entry.append(el("p", "h3p-warning", "原绑定素材未激活或已失效，请重新选择。"));
                }
                if (source.role) this.textEditor(entry, "素材分工", source.role, value => {
                    source.role = value;
                }, `definitions.${definition.id}.sources.${index}`);
            }
            const grid = el("div", "h3p-grid");
            const type = input("可复用对象", () => {}, "定义类型"); type.readOnly = true;
            field(grid, "定义类型", type);
            field(grid, "用途", select(PURPOSES.Subject, definition.purpose, value => {
                definition.purpose = value; this.commit("definitions." + definition.id + ".purpose");
            }, "定义用途"));
            entry.append(grid);
            this.textEditor(entry, "描述", definition.description, value => {
                definition.description = value;
            }, "definitions." + definition.id);
            body.append(entry);
        }
        body.append(button("添加 Subject", "plus", () => this.structural(() => this.doc.definitions.push({
            id: uid("definition"), name: "", kind: "Subject", purpose: "character", description: "",
            sources: [], relation: "fully_preserved", keep: "", change: "", scope: [],
        }))));
        const independent = el("details", "h3p-independent-definitions");
        independent.open = this.independentOpen ?? this.doc.definitions.some(item => item.kind !== "Subject");
        independent.addEventListener("toggle", () => { if (independent.isConnected) this.independentOpen = independent.open; });
        independent.append(el("summary", "", "独立参考 · Picture / Video / Audio"));
        const independentBody = el("div", "h3p-section-body"); independent.append(independentBody); body.append(independent);
        for (const definition of this.doc.definitions.filter(item => item.kind !== "Subject")) {
            const entry = el("div", "h3p-definition"), title = el("div", "h3p-entry-heading");
            entry.dataset.independentId = definition.id;
            title.append(el("strong", "", definition.name || "未命名定义"),
                button("", "trash", () => this.structural(() => {
                    this.doc.definitions = this.doc.definitions.filter(d => d.id !== definition.id);
                }), "删除定义（可撤销）"));
            entry.append(title);
            const source = definition.sources[0];
            const activeAssets = this.doc.assets.filter(asset => !asset.skip && !asset.missing);
            const asset = activeAssets.find(item => item.id === source?.asset_id);
            field(entry, "选择素材", select([["", "选择素材"], ...activeAssets.map(item => [item.id, `@${item.alias || item.label}`])],
                asset?.id || "", value => this.structural(() => {
                    const selected = activeAssets.find(item => item.id === value);
                    definition.sources = value ? [{ asset_id: value, role: source?.role || "" }] : [];
                    if (!selected) return;
                    definition.name = selected.alias || selected.label;
                    const kinds = selected.kind === "image" ? ["Picture"] : selected.kind === "audio" ? ["Audio"]
                        : ["Video", ...(selected.audio_enabled ? ["Audio"] : [])];
                    if (!kinds.includes(definition.kind)) {
                        definition.kind = kinds[0];
                        definition.relation = definition.kind === "Audio" ? "reference" : "fully_preserved";
                        definition.purpose = PURPOSES[definition.kind][0][0];
                    }
                }), "独立参考素材"));
            if (source?.asset_id && !asset) entry.append(el("p", "h3p-warning", "原绑定素材未激活或已失效，请重新选择。"));
            if (definition.sources.length > 1) entry.append(el("p", "h3p-warning", "独立参考需绑定一个素材，请重新选择。"));
            const kinds = !asset ? [] : asset.kind === "image" ? ["Picture"] : asset.kind === "audio" ? ["Audio"]
                : ["Video", ...(asset.audio_enabled ? ["Audio"] : [])];
            const ways = kinds.flatMap(kind => PURPOSES[kind].map(([purpose, label]) => [`${kind}:${purpose}`, label]));
            const way = select(ways.length ? ways : [["", "先选择素材"]], asset ? `${definition.kind}:${definition.purpose}` : "",
                value => this.structural(() => {
                    const [kind, purpose] = value.split(":");
                    if (definition.kind !== kind) definition.relation = kind === "Audio" ? "reference" : "fully_preserved";
                    definition.kind = kind; definition.purpose = purpose;
                }), "参考方式");
            way.disabled = !asset; field(entry, "参考方式", way);
            this.textEditor(entry, "定义", definition.description, value => {
                definition.description = value;
            }, "definitions." + definition.id);
            if (source?.role) {
                this.textEditor(entry, "素材分工", source.role, value => { source.role = value; }, `definitions.${definition.id}.sources.0`);
            }
            if (definition.kind === "Audio" && definition.purpose === "voice") {
                field(entry, "绑定发声者", select(this.speakers(), definition.speaker, value => {
                    definition.speaker = value; this.commit();
                }, "音色绑定发声者"));
            }
            if (definition.kind === "Picture") this.seconds(entry, "锚点时间（秒，可选）", definition.anchor_ms, v => { definition.anchor_ms = v; }, "definitions." + definition.id + ".anchor_ms");
            independentBody.append(entry);
        }
        independentBody.append(button("添加独立参考", "plus", () => this.structural(() => {
            this.independentOpen = true;
            this.doc.definitions.push({
                id: uid("definition"), name: "", kind: "Picture", purpose: "first frame", description: "",
                sources: [], relation: "fully_preserved", keep: "", change: "", scope: [],
            });
        })));
    }
    renderRetention(parent) {
        const { body } = this.section("保留分析", "retention", parent);
        if (!this.doc.definitions.length) body.append(el("p", "h3p-note", "暂无定义。"));
        for (const definition of this.doc.definitions) {
            const entry = el("div", "h3p-definition");
            entry.append(el("h4", "", definition.name || "未命名定义"));
            this.optionField(entry, "参考关系", definition.kind === "Audio" ? AUDIO : VISUAL, definition.relation,
                value => this.structural(() => { definition.relation = value; }));
            this.textEditor(entry, "保留内容", definition.keep, v => { definition.keep = v; }, "definitions." + definition.id + ".keep");
            this.textEditor(entry, "修改内容", definition.change, v => { definition.change = v; }, "definitions." + definition.id + ".change");
            if (definition.relation === "attribute_transfer") this.textEditor(entry, "转移到哪个目标", definition.transfer_target,
                v => { definition.transfer_target = v; }, "definitions." + definition.id + ".transfer_target");
            const scope = el("div", "h3p-scope");
            scope.append(checkbox("全段生效", !definition.scope?.length, v => this.structural(() => {
                definition.scope = v ? [] : [this.doc.shots[0].id];
            })));
            if (definition.scope?.length) {
                for (const shot of shotLabels(this.doc)) scope.append(checkbox(shot.label, definition.scope.includes(shot.id), checked => {
                    this.structural(() => {
                        definition.scope = checked ? [...definition.scope, shot.id] : definition.scope.filter(id => id !== shot.id);
                    });
                }));
                if (definition.scope.some(id => !shotLabels(this.doc).some(shot => shot.id === id))) scope.append(el("span", "h3p-error", "包含已删除镜头，请重新指定。"));
            }
            entry.append(scope); body.append(entry);
        }
    }
    renderMC(parent) {
        const { body, section } = this.section("Motion Context 接续", "mc", parent);
        section.classList.add("h3p-subsection");
        body.append(checkbox("本段使用 Motion Context", this.doc.mc.enabled, value => this.structural(() => { this.doc.mc.enabled = value; })));
        if (!this.doc.mc.enabled) return;
        const mc = this.doc.mc, grid = el("div", "h3p-grid");
        const candidates = mcCandidates(this.graph?._nodes || []);
        if (candidates.length) {
            field(body, "工作流接续节点", select([["", "选择节点核对"], ...candidates.map(c => [c.id, `${c.label} · 节点 ${c.id}`])],
                mc.node_id, id => this.structural(() => { mc.node_id = id; mc.source = "manual"; }), "工作流接续节点"));
            const selected = candidates.find(c => c.id === mc.node_id);
            if (selected) body.append(el("p", "h3p-note",
                `该节点请求上下文 ${selected.requested ?? "未知"} 帧，${selected.hasContext ? "已接入上下文来源" : "未接入上下文来源"}。请求值不等于实际执行值；以下边界仍需接线或手动确认。`));
        }
        body.append(grid);
        for (const [key, name] of [["overlap_frames", "实际重叠帧数"], ["trim_frames", "实际裁切帧数"], ["fps", "实际帧率"]]) {
            const control = input(mc[key], value => { mc[key] = value; mc.source = "manual"; this.commit("mc." + key); this.updateMCStatus(); }, name, "number");
            control.step = "1"; control.placeholder = "待确认"; field(grid, name, control, "mc." + key);
        }
        this.mcStatus = el("p", "h3p-note"); body.append(this.mcStatus); this.updateMCStatus();
        field(body, "重叠结束后", select([["continue", "继续 Shot 1"], ["cut", "切入 Shot 2"]], mc.mode,
            value => this.structural(() => { mc.mode = value; }), "重叠结束后"));
        const carry = el("div", "h3p-field"); carry.dataset.path = "mc.carry";
        carry.append(el("span", "h3p-label", "Shot 1 · 承接区（裁切区无台词）"));
        this.richEditor(carry, mc.carry, runs => { mc.carry = runs; }, "mc.carry", true, true); body.append(carry);
        body.append(button("插入承接描述", "plus", () => this.structural(() => {
            mc.carry.push({ kind: "text", text: "Continue the preceding clip's ending motion, gaze and camera trajectory naturally through the overlap, without freezing or introducing new dialogue." });
        })));
    }
    updateMCStatus() {
        if (!this.mcStatus) return;
        const mc = this.doc.mc, seconds = frames => frames == null || !mc.fps ? "待确认" : `${(frames / mc.fps).toFixed(3)} 秒`;
        this.mcStatus.textContent = `重叠：${seconds(mc.overlap_frames)}；实际裁切：${seconds(mc.trim_frames)}。边界按帧数 ÷ 帧率计算，不用显示舍入值做检查。`;
    }
    renderShots(parent) {
        const { body, section } = this.section("镜头", "shots", parent);
        section.classList.add("h3p-subsection");
        const cut = this.doc.mc.enabled && this.doc.mc.mode === "cut";
        for (const [index, shot] of this.doc.shots.entries()) {
            const wrapper = el("section", "h3p-shot"); wrapper.dataset.path = "shots." + shot.id;
            const title = el("div", "h3p-entry-heading"), label = `Shot ${index + (cut ? 2 : 1)}`;
            title.append(el("h4", "", label + (index === 0 && this.doc.mc.enabled ? " · 保留区" : "")));
            const tools = el("div", "h3p-row");
            const collapse = button("", shot.collapsed ? "chevron-down" : "chevron-up", () => {
                this.structural(() => { shot.collapsed = !shot.collapsed; });
            }, shot.collapsed ? "展开镜头" : "收起镜头");
            tools.append(collapse);
            if (index > 0) {
                const up = button("", "arrow-up", () => this.structural(() => moveShot(this.doc, shot.id, -1)), "上移镜头");
                up.disabled = index === 1;
                const down = button("", "arrow-down", () => this.structural(() => moveShot(this.doc, shot.id, 1)), "下移镜头");
                down.disabled = index === this.doc.shots.length - 1;
                tools.append(up, down, button("", "trash", () => this.structural(() => removeShot(this.doc, shot.id)), "删除镜头（可撤销）"));
            }
            title.append(tools); wrapper.append(title);
            if (index === 0) wrapper.append(el("p", "h3p-note", cut
                ? "在实际裁切边界切入；时间由帧数与帧率推导，保留区正文不会因切换 MC 模式丢失。"
                : "从 0 秒开始；正文内可插入独立动作或发声时间点。"));
            else this.seconds(wrapper, "切镜开始时间（秒）", shot.start_ms, v => { shot.start_ms = v; }, "shots." + shot.id + ".start_ms");
            if (!shot.collapsed) this.richEditor(wrapper, shot.runs, runs => { shot.runs = runs; }, "shots." + shot.id);
            body.append(wrapper);
        }
        body.append(button("添加 Shot", "plus", () => this.structural(() => addShot(this.doc))));
    }
    render() {
        const scrollTop = this.body?.scrollTop ?? 0;
        this.helpOpen ??= new Map();
        for (const section of this.root.querySelectorAll("[data-section-key]")) {
            const help = section.querySelector(".h3p-help");
            if (help) this.helpOpen.set(section.dataset.sectionKey, help.open);
        }
        this.rememberOutputState(); this.hideHint(); this.closeReferenceMenu();
        if (!this.topbar || !this.root.contains(this.topbar)) {
            this.root.replaceChildren();
            this.topbar = el("div", "h3p-topbar"); this.modes = el("div", "h3p-modes");
            this.modeButtons = new Map();
            for (const [mode, label] of [["compose", "编排模式"], ["native", "原生输入模式"]]) {
                const control = button(label, mode === "compose" ? "sliders-h" : "align-left", () => {
                    if (this.doc.mode !== mode) this.structural(() => { this.doc.mode = mode; });
                });
                this.modeButtons.set(mode, control); this.modes.append(control);
            }
            const history = el("div", "h3p-row");
            history.append(button("", "undo", () => this.undo(), "撤销"), button("", "refresh", () => this.redo(), "重做"));
            this.topbar.append(this.modes, history); this.root.append(this.topbar);
            this.status = el("div", "h3p-status"); this.status.setAttribute("role", "status"); this.root.append(this.status);
            this.body = el("div", "h3p-body"); this.root.append(this.body);
        }
        this.modes.dataset.mode = this.doc.mode;
        for (const [mode, control] of this.modeButtons) {
            control.classList.toggle("h3p-active", this.doc.mode === mode); control.setAttribute("aria-pressed", String(this.doc.mode === mode));
        }
        const body = this.body; body.replaceChildren();
        this.renderAssets(body);
        if (this.doc.mode === "native") {
            const native = el("textarea", "h3p-native"); native.setAttribute("aria-label", "原生提示词");
            native.value = this.doc.native_text; native.spellcheck = false;
            native.addEventListener("input", () => { this.doc.native_text = native.value; this.commit("native_text"); });
            field(body, "原生提示词", native, "native_text");
        } else {
            this.renderDefinitions(body);
            const { body: settings } = this.section("概要", "summary", body);
            const taskArea = el("div", "h3p-tasks"); settings.append(taskArea);
            for (const task of TASKS) {
                const row = el("div", "h3p-task");
                row.append(checkbox(task.label, this.doc.tasks.includes(task.value), checked => {
                    this.doc.tasks = checked ? [...this.doc.tasks, task.value] : this.doc.tasks.filter(t => t !== task.value); this.commit();
                }));
                const details = el("details", "h3p-option-help");
                details.append(el("summary", "", "说明"), el("p", "", task.detail)); row.append(el("small", "", task.short), details); taskArea.append(row);
            }
            this.seconds(settings, "本段总时长（秒）", this.doc.duration_ms, v => { this.doc.duration_ms = v; }, "duration_ms");
            this.textEditor(settings, "概要", this.doc.summary, v => { this.doc.summary = v; }, "summary");
            this.renderRetention(body);
            const { body: detailed } = this.section("详细描述", "detailed", body);
            this.textEditor(detailed, "总体画风与光照", this.doc.style, v => { this.doc.style = v; }, "style");
            this.renderMC(detailed); this.renderShots(detailed);
            const { body: sound } = this.section("环境声音", "sound", body);
            this.textEditor(sound, "环境与物理声音", this.doc.soundscape, v => { this.doc.soundscape = v; }, "soundscape");
            const { body: music } = this.section("观众配乐", "music", body);
            music.append(checkbox("有观众配乐", this.doc.music.enabled, value => this.structural(() => { this.doc.music.enabled = value; })));
            if (this.doc.music.enabled) this.textEditor(music, "配乐需求", this.doc.music.text, v => { this.doc.music.text = v; }, "music.text");
        }
        const { body: output, heading } = this.section("输出与检查", "output", body);
        heading.append(button("复制输出", "copy", async () => {
            const result = await this.compileNow(); if (result) await this.copy(result.prompt);
        }));
        if (this.doc.mode === "compose") output.append(button("从编排结果填入原生模式", "arrow-right", () => this.prepareNative(output)));
        this.issuesArea = el("div", "h3p-issues"); output.append(this.issuesArea);
        this.previewArea = el("div", "h3p-preview-area"); output.append(this.previewArea); this.renderResults();
        body.scrollTop = scrollTop;
        if (this.renderedMode && this.renderedMode !== this.doc.mode) this.reveal(body);
        this.renderedMode = this.doc.mode;
    }
    async prepareNative(parent) {
        const result = await this.compileNow(); if (!result) return;
        parent.querySelector(".h3p-native-replace")?.remove();
        const replacement = el("div", "h3p-native-replace");
        const preview = el("pre", "h3p-output-text", result.prompt);
        replacement.append(el("p", "", this.doc.native_text ? "已有原生草稿。确认后替换为以下内容：" : "确认填入以下编排结果："),
            preview, button("确认填入并切换", "check", () => this.structural(() => {
                this.doc.native_text = result.prompt; this.doc.mode = "native";
            })), button("取消", "times", () => replacement.remove()));
        parent.prepend(replacement);
    }
    rememberOutputState() {
        this.outputOpen ??= new Map();
        for (const details of this.previewArea?.querySelectorAll("[data-output-field]") ?? []) {
            this.outputOpen.set(details.dataset.outputField, details.open);
        }
    }
    renderResults() {
        if (!this.previewArea || !this.issuesArea) return;
        const scrollTop = this.body?.scrollTop ?? 0;
        this.rememberOutputState();
        const editingOverride = this.previewArea.contains(document.activeElement)
            && document.activeElement.classList.contains("h3p-override");
        this.issuesArea.replaceChildren();
        if (!this.lastCompiled) { this.setStatus("正在编排…"); return; }
        const result = this.lastCompiled;
        const errors = result.issues.filter(row => row.level === "error").length;
        const warnings = result.issues.length - errors;
        this.setStatus(`${errors} 个错误，${warnings} 条提醒 · ${result.translation}`, errors > 0);
        for (const row of result.issues) {
            const control = button(row.message, row.level === "error" ? "exclamation-circle" : "info-circle", () => {
                const candidates = [...this.root.querySelectorAll("[data-path]")];
                const target = candidates.filter(e => row.path.startsWith(e.dataset.path))
                    .sort((a, b) => b.dataset.path.length - a.dataset.path.length)[0];
                target?.scrollIntoView({ block: "center", behavior: "smooth" });
                target?.querySelector("input,[contenteditable=true],textarea")?.focus();
            }, row.path + "：" + row.message);
            control.classList.add(row.level === "error" ? "h3p-error" : "h3p-warning"); this.issuesArea.append(control);
        }
        for (const badge of this.root.querySelectorAll("[data-speaker-id]")) badge.textContent = result.speaker_map[badge.dataset.speakerId] || "S?";
        if (editingOverride) return;
        this.previewArea.replaceChildren();
        if (this.doc.mode === "native") {
            this.previewArea.append(el("pre", "h3p-output-text", result.prompt));
            if (this.body) this.body.scrollTop = scrollTop;
            return;
        }
        const names = ["定义", "概要", "保留关系", "详细镜头", "环境声音", "观众配乐"];
        for (const [index, key] of FIELDS.entries()) {
            const details = el("details", "h3p-output-section"), summary = el("summary", "", names[index]);
            details.dataset.outputField = key;
            details.open = this.outputOpen.get(key) ?? (key === "detailed_description");
            const override = this.doc.overrides[key];
            const controls = el("div", "h3p-row");
            controls.append(checkbox("手动修改并锁定此段", override?.locked, locked => this.structural(() => {
                this.doc.overrides[key] = { text: override?.text ?? result.fields[key], locked };
            })));
            details.append(summary, el("small", "h3p-official-field", key), controls);
            if (override?.locked) {
                const textarea = el("textarea", "h3p-override"); textarea.value = override.text;
                textarea.setAttribute("aria-label", names[index] + "锁定文本");
                textarea.addEventListener("input", () => { override.text = textarea.value; this.commit("override." + key); });
                details.append(textarea);
            } else details.append(el("pre", "h3p-output-text", result.fields[key]));
            this.previewArea.append(details);
        }
        if (this.body) this.body.scrollTop = scrollTop;
    }
    async copy(text) {
        try { await navigator.clipboard.writeText(text); this.setStatus("已复制"); }
        catch { this.setStatus("复制失败，请在输出区选中文本复制。", true); }
    }
    dispose() {
        this.disposed = true; clearTimeout(this.compileTimer); this.lifetime.abort();
        this.hideHint(); this.closeReferenceMenu(); this.previewDialog?.remove(); this.root.remove();
    }
}
