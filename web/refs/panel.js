import {
    LIMITS, KIND_NAMES, PURPOSES, VIDEO_SIZES, UPLOAD_ROOT, customVideoSide, decodedVideoSize, planImageSize, parseDocument, serializeDocument,
    assignLabels, manifestText, addCards, removeCard, placeCard, splitCards, activeCount, setAllSkip, clearCards,
    nameFromFile, mediaKind, projectFolder, formatSeconds, trimWindow, newId, libraryKey, matchLibrary,
    toPresetEntries, fromPresetEntries, CARD_DENSITIES, normalizeCardDensity,
} from "./refs_state.js";
import { openLibraryBrowser } from "./library_browser.js";

const DEFAULT_PROJECT = "H3_LVM";
const DRAG_TYPE = "application/x-amiaomiao-ref-card";
// Node inputs that only affect images; the hub hides them and shows them on the image page.
export const IMAGE_SETTINGS = ["target_megapixels", "resampling_method", "upscale_small_images"];
const RESAMPLE_OPTIONS = ["Lanczos", "Bicubic", "Bilinear", "Nearest"];
const peakCache = new Map();

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
function iconButton(name, title, onClick, className = "") {
    const button = el("button", `ahr-icon-btn ${className}`.trim());
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.append(icon(name));
    button.addEventListener("click", event => { event.stopPropagation(); onClick(event); });
    return button;
}
function textButton(label, iconName, onClick, className = "") {
    const button = el("button", `ahr-btn ${className}`.trim());
    button.type = "button";
    if (iconName) button.append(icon(iconName));
    button.append(el("span", "", label));
    button.addEventListener("click", event => { event.stopPropagation(); onClick(event); });
    return button;
}
function select(options, value, onChange, label) {
    const control = el("select", "ahr-select");
    control.setAttribute("aria-label", label);
    for (const [optionValue, text] of options) {
        const option = el("option", "", text);
        option.value = String(optionValue);
        control.append(option);
    }
    control.value = String(value ?? "");
    control.addEventListener("change", () => onChange(control.value));
    return control;
}

export class RefHubPanel {
    constructor({ api, value, onChange, settings }) {
        this.api = api;
        this.onChange = onChange;
        // { get(name), set(name, value) } bound to the node's own widgets, so the values keep
        // their saved position in widgets_values and the backend reads them unchanged.
        this.settings = settings || null;
        this.doc = parseDocument(value);
        this.projectBaselines = new Map();
        this.restoreProjectBaselines();
        this.pendingImports = 0;
        this.results = new Map();
        this.imageSizes = new Map();
        this.libraries = new Map();
        this.customVideoSides = new Set();
        this.projects = new Map();
        this.root = el("div", "ahr");
        this.root.tabIndex = -1;
        // A run finishing while the user types must not rebuild the field under the cursor.
        this.root.addEventListener("focusout", event => {
            if (this.pendingRender && !this.isTyping(event.relatedTarget)) {
                this.pendingRender = false;
                requestAnimationFrame(() => this.render());
            }
        });
        this.bindDrop();
        this.render();
    }

    isTyping(target = document.activeElement) {
        return !!target && this.root.contains(target) && target.matches?.("input:not([type=checkbox]), textarea");
    }

    load(value) {
        this.doc = parseDocument(value);
        this.projectOperation = null;
        this.projectChoice = null;
        this.restoreProjectBaselines();
        this.render();
    }

    dispose() {
        this.disposed = true;
        this.projectOperation = null;
        this.closePreview();
        this.stopAudio();
        clearTimeout(this.toastTimer);
    }

    save(rerender = false) {
        for (const kind of ["image", "audio"]) {
            const binding = this.projectBinding(kind);
            if (binding) binding.dirty = this.projectBaselines.get(kind) !== this.projectSignature(kind);
        }
        this.onChange(serializeDocument(this.doc));
        if (rerender) this.render();
        else this.updateCounts();
    }

    url(path) {
        return typeof this.api.apiURL === "function" ? this.api.apiURL(path) : path;
    }

    fileUrl(card, endpoint = "/view") {
        const query = new URLSearchParams({ filename: card.filename, subfolder: card.subfolder || "",
            type: card.type || "input" });
        return this.url(`${endpoint}?${query}`);
    }

    toast(message, error = false) {
        if (!this.status) return;
        this.status.textContent = message;
        this.status.classList.toggle("is-error", error);
        this.status.classList.add("is-visible");
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => this.status?.classList.remove("is-visible"), 2600);
    }

    // ---------- layout ----------
    render() {
        const scroll = this.body?.scrollTop ?? 0;
        // A drop re-renders the card that started the drag, so its dragend never fires.
        this.dragKind = null;
        delete this.root.dataset.dragging;
        this.setFileHover();
        this.root.replaceChildren();
        this.labels = assignLabels(this.doc);
        const header = el("div", "ahr-header");
        const title = el("div", "ahr-title");
        title.append(icon("images"), el("span", "", "H3 参考素材"));
        this.tabs = el("div", "ahr-tabs");
        this.tabs.setAttribute("role", "tablist");
        for (const [page, label, iconName] of [["image", "图片", "image"], ["audio", "音频", "volume-up"], ["video", "视频", "video"]]) {
            const tab = el("button", "ahr-tab");
            tab.type = "button";
            tab.dataset.page = page;
            tab.dataset.kind = page;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-selected", String(this.doc.ui.page === page));
            tab.append(icon(iconName), el("span", "", label), el("span", "ahr-tab-count"));
            tab.addEventListener("click", () => {
                if (this.doc.ui.page === page) return;
                this.doc.ui.page = page;
                this.save(true);
            });
            this.tabs.append(tab);
        }
        const actions = el("div", "ahr-actions");
        const density = el("div", "ahr-density");
        density.setAttribute("role", "group");
        density.setAttribute("aria-label", "卡片尺寸");
        const currentDensity = normalizeCardDensity(this.doc.ui.density);
        for (const [value, iconName, label] of CARD_DENSITIES) {
            const option = iconButton(iconName, label, () => {
                const previous = this.root.dataset.density;
                if (previous === value) return;
                this.doc.ui.density = value;
                if (this.doc.ui.page === "audio" || previous === "xlarge" || value === "xlarge") {
                    this.save(true);
                    this.root.querySelector(`.ahr-density [data-value="${value}"]`)?.focus();
                    return;
                }
                this.root.dataset.density = value;
                this.save();
                for (const child of density.children) child.setAttribute("aria-pressed", String(child.dataset.value === value));
                requestAnimationFrame(() => this.drawWaveforms());
            }, "is-seg");
            option.dataset.value = value;
            option.setAttribute("aria-pressed", String(currentDensity === value));
            density.append(option);
        }
        actions.append(density, textButton("复制素材清单", "copy", () => this.copyManifest(), "is-quiet"));
        this.root.dataset.density = currentDensity;
        header.append(title, this.tabs, actions);
        this.status = el("div", "ahr-toast");
        this.status.setAttribute("role", "status");
        this.body = el("div", "ahr-body");
        this.body.inert = !!this.projectOperation;
        this.body.setAttribute("aria-busy", String(!!this.projectOperation));
        if (this.doc.ui.page !== "video") this.body.append(this.projectBar(this.doc.ui.page));
        if (this.projectChoice?.kind === this.doc.ui.page) this.body.append(this.renderProjectChoice());
        if (this.doc.ui.page === "video") this.renderVideoPage(this.body);
        else if (this.doc.ui.page === "audio") this.renderAudioPage(this.body);
        else this.renderImagePage(this.body);
        this.root.append(header, this.body, this.status);
        this.updateCounts();
        this.body.scrollTop = scroll;
        requestAnimationFrame(() => this.drawWaveforms());
    }

    updateCounts() {
        if (!this.tabs) return;
        const counts = {
            image: String(activeCount(this.doc, "image")),
            video: String(activeCount(this.doc, "video")),
            audio: String(activeCount(this.doc, "audio")),
        };
        for (const tab of this.tabs.children) tab.querySelector(".ahr-tab-count").textContent = counts[tab.dataset.page];
    }

    section(kind, titleText) {
        const section = el("section", `ahr-section is-${kind}`);
        const head = el("div", "ahr-section-head");
        const name = el("h3", "ahr-section-title");
        name.append(el("span", "ahr-kind-dot"), el("span", "", titleText));
        const count = el("span", "ahr-count", `${activeCount(this.doc, kind)} / ${LIMITS[kind]}`);
        head.append(name, count);
        section.append(head);
        return { section, head };
    }

    // Remove every card of one kind, with an inline confirm (files on disk are kept).
    clearButton(kind) {
        const noun = KIND_NAMES[kind];
        const total = this.doc[`${kind}s`].length;
        const button = iconButton("trash", `清空全部${noun}卡片`, () => {
            const confirm = el("div", "ahr-clear-confirm");
            confirm.setAttribute("role", "group");
            confirm.setAttribute("aria-label", `确认清空${noun}`);
            const yes = textButton(`清空 ${total} 个`, "trash", () => {
                clearCards(this.doc, kind);
                this.save(true);
                this.toast(`已清空${noun}卡片（文件仍保留）`);
            }, "is-danger-solid");
            const no = textButton("取消", "", () => confirm.replaceWith(button));
            confirm.append(el("span", "ahr-clear-text", `清空全部${noun}？`), yes, no);
            button.replaceWith(confirm);
            no.focus();
            confirm.addEventListener("keydown", event => {
                if (event.key === "Escape") { event.stopPropagation(); confirm.replaceWith(button); button.focus(); }
            });
        }, "is-danger");
        button.disabled = !total;
        return button;
    }

    batchSkip(kind, skip) {
        const noun = KIND_NAMES[kind];
        const { changed, left } = setAllSkip(this.doc, kind, skip);
        if (!changed && !left) return;
        this.save(true);
        if (skip) this.toast(`已停用全部${noun}（${changed} 个）`);
        else if (left) this.toast(`已启用 ${changed} 个，${noun}最多启用 ${LIMITS[kind]} 个，其余 ${left} 个仍停用`, !changed);
        else this.toast(`已启用全部${noun}（${changed} 个）`);
    }

    // ---------- page 1: images ----------
    renderImagePage(body) {
        const images = this.section("image", "图片");
        if (this.settings) images.head.append(this.imageSettings());
        images.head.append(this.clearButton("image"), textButton("添加图片", "plus", () => this.pickFiles("image")));
        images.section.append(...this.zones("image", "ahr-image-grid", card => this.imageCard(card),
            () => this.addTile("image", "添加图片", "image")));
        body.append(images.section);
    }

    // Output size for every image: target megapixels, resampling filter, upscale small images.
    imageSettings() {
        const box = el("div", "ahr-image-settings");
        box.setAttribute("role", "group");
        box.setAttribute("aria-label", "图片输出设置");
        const mp = el("label", "ahr-setting");
        mp.title = "每张图的目标像素量（百万像素），按各自比例缩放并对齐 32 像素";
        const number = el("input", "ahr-number ahr-mp");
        number.type = "number";
        number.min = "0.02";
        number.max = "8";
        number.step = "0.01";
        number.value = String(this.settings.get("target_megapixels") ?? 0.25);
        number.setAttribute("aria-label", "图片目标像素量（MP）");
        number.addEventListener("change", () => {
            const value = Math.min(8, Math.max(0.02, Math.round((Number(number.value) || 0.25) * 100) / 100));
            number.value = String(value);
            this.settings.set("target_megapixels", value);
            this.refreshImageSizes();
        });
        mp.append(el("span", "ahr-setting-label", "目标像素"), number, el("span", "ahr-setting-unit", "MP"));
        const method = select(RESAMPLE_OPTIONS.map(name => [name, name]), this.settings.get("resampling_method") || "Lanczos",
            value => this.settings.set("resampling_method", value), "图片重采样");
        method.title = "图片重采样";
        method.classList.add("ahr-setting-select");
        const upscale = el("label", "ahr-toggle ahr-setting");
        upscale.title = "开启：比目标像素小的图片放大到目标像素\n关闭：小图保持原尺寸，只微调到 32 的倍数";
        const checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.checked = !!this.settings.get("upscale_small_images");
        checkbox.addEventListener("change", () => { this.settings.set("upscale_small_images", checkbox.checked); this.refreshImageSizes(); });
        upscale.append(checkbox, el("span", "ahr-switch"), el("span", "", "小于目标时放大"));
        box.append(mp, method, upscale);
        return box;
    }

    // ---------- page 3: audio ----------
    renderAudioPage(body) {
        const audios = this.section("audio", "音频");
        const detailed = normalizeCardDensity(this.doc.ui.density) !== "medium";
        audios.head.append(this.clearButton("audio"), textButton("添加音频", "plus", () => this.pickFiles("audio")));
        audios.section.append(...this.zones("audio", `ahr-audio-list${detailed ? "" : " is-compact"}`,
            card => detailed ? this.audioCard(card) : this.audioRow(card),
            () => this.addTile("audio", "添加音频", "volume-up", true)));
        body.append(audios.section);
    }

    // Active cards (numbered, sent to H3) and parked cards (kept, not sent) in two zones.
    zones(kind, listClass, render, addTile) {
        const { active, parked } = splitCards(this.doc, kind);
        const out = [];
        const activeZone = el("div", "ahr-zone is-active");
        const activeHead = el("div", "ahr-zone-head");
        activeHead.append(el("span", "ahr-zone-dot"), el("span", "ahr-zone-title", "启用 · 会输出"),
            el("span", "ahr-zone-count", `${active.length} / ${LIMITS[kind]}`));
        if (active.length) {
            const off = textButton("全部停用", "pause", () => this.batchSkip(kind, true), "ahr-zone-action is-disable");
            off.title = `把启用区的全部${KIND_NAMES[kind]}移到停用区`;
            activeHead.append(off);
        }
        const activeList = el("div", listClass);
        for (const card of active) activeList.append(render(card));
        if (active.length < LIMITS[kind]) activeList.append(addTile());
        activeZone.append(activeHead, activeList);
        this.makeZoneDrop(activeZone, kind, false);
        out.push(activeZone);
        // Always present so it can receive a drag; collapses to one line when empty.
        const parkedZone = el("div", `ahr-zone is-parked${parked.length ? "" : " is-empty"}`);
        const parkedHead = el("div", "ahr-zone-head");
        parkedHead.append(el("span", "ahr-zone-dot"), el("span", "ahr-zone-title", "停用 · 不输出，卡片保留"),
            el("span", "ahr-zone-count", parked.length ? String(parked.length) : "拖卡片到这里停用"));
        if (parked.length) {
            const on = textButton("全部启用", "play", () => this.batchSkip(kind, false), "ahr-zone-action is-enable");
            on.title = `按顺序启用停用区的${KIND_NAMES[kind]}，最多 ${LIMITS[kind]} 个`;
            on.disabled = active.length >= LIMITS[kind];
            if (on.disabled) on.title = `启用区已满 ${LIMITS[kind]} 个`;
            parkedHead.append(on);
        }
        parkedZone.append(parkedHead);
        if (parked.length) {
            const parkedList = el("div", listClass);
            for (const card of parked) parkedList.append(render(card));
            parkedZone.append(parkedList);
        }
        this.makeZoneDrop(parkedZone, kind, true);
        out.push(parkedZone);
        return out;
    }

    makeZoneDrop(zone, kind, skip) {
        zone.addEventListener("dragover", event => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE) || this.dragKind !== kind) return;
            event.preventDefault();
            zone.classList.add("is-drop");
        });
        zone.addEventListener("dragleave", event => {
            if (!zone.contains(event.relatedTarget)) zone.classList.remove("is-drop");
        });
        zone.addEventListener("drop", event => {
            zone.classList.remove("is-drop");
            const raw = event.dataTransfer.getData(DRAG_TYPE);
            if (!raw) return;
            event.preventDefault();
            const moving = JSON.parse(raw);
            if (moving.kind !== kind) return;
            this.applyPlace(kind, moving.id, skip, Infinity);
        });
    }

    applyPlace(kind, id, skip, index) {
        const result = placeCard(this.doc, kind, id, skip, index);
        if (!result.ok && result.reason === "full") {
            this.toast(`${KIND_NAMES[kind]}最多启用 ${LIMITS[kind]} 个，先停用一个再启用`, true);
            return;
        }
        this.save(true);
    }

    // ---------- reference projects: separate image and audio libraries ----------
    // Same libraries as the old image / audio reference loaders (h3-lvm-image-refs, h3-lvm-audio-refs).
    refProject(kind) {
        return this.doc.ui[`${kind}_project`] || DEFAULT_PROJECT;
    }

    projectBinding(kind) {
        const binding = this.doc.ui[`${kind}_project_binding`];
        return binding?.project === this.refProject(kind) && typeof binding.revision === "string" ? binding : null;
    }

    projectSignature(kind, doc = this.doc) {
        return JSON.stringify(toPresetEntries(doc, kind));
    }

    restoreProjectBaselines() {
        this.projectBaselines.clear();
        for (const kind of ["image", "audio"]) {
            if (this.projectBinding(kind)?.dirty === false) this.projectBaselines.set(kind, this.projectSignature(kind));
        }
    }

    bindProject(kind, project, revision) {
        this.doc.ui[`${kind}_project`] = project;
        this.doc.ui[`${kind}_project_binding`] = { project, revision, dirty: false };
        this.projectBaselines.set(kind, this.projectSignature(kind));
    }

    detachProject(kind) {
        delete this.doc.ui[`${kind}_project_binding`];
        this.projectBaselines.delete(kind);
    }

    projectBar(kind) {
        const noun = KIND_NAMES[kind];
        const bar = el("div", `ahr-project-bar is-${kind}`);
        const label = el("span", "ahr-project-label");
        label.append(icon("folder"), el("span", "", `${noun}项目库`));
        const project = this.refProject(kind);
        const control = select([[project, project]], project, value => {
            control.value = project;
            this.switchRefProject(kind, value);
        }, `${noun}项目库`);
        control.classList.add("ahr-project-select");
        this.fillRefProjects(control, kind);
        const create = iconButton("plus", `新建${noun}项目`, () => this.showCreateProject(bar, kind));
        const refresh = iconButton("refresh", "刷新当前项目", () => this.switchRefProject(kind, project, { refresh: true }));
        const store = textButton("保存", "save", () => this.saveRefProject(kind));
        store.title = `把当前${noun}卡片保存到这个项目，旧的${noun}参考载入器也能读取`;
        const browse = textButton("浏览", "folder-open", () => this.openRefLibrary(kind), "is-library");
        browse.title = `打开${noun}项目库（封面、内容预览、重命名、删除）`;
        browse.setAttribute("aria-label", `打开${noun}项目库`);
        bar.append(label, control, browse, create, refresh, store);
        return bar;
    }

    // Project library browser: image / audio projects.
    openRefLibrary(kind) {
        const doc = this.doc;
        const current = () => !this.disposed && this.doc === doc;
        openLibraryBrowser({
            scope: kind, current: this.refProject(kind), url: path => this.url(path),
            fetchJson: (path, options) => this.fetchJson(path, options),
            directReferenceSwitch: true,
            onUse: name => current() && this.switchRefProject(kind, name),
            onRenamed: (from, to) => {
                if (!current()) return;
                if (this.refProject(kind) === from) {
                    this.doc.ui[`${kind}_project`] = to;
                    this.detachProject(kind);
                }
                this.projects.delete(kind);
                this.save(true);
            },
            onDeleted: name => {
                if (!current()) return;
                if (this.refProject(kind) === name) this.detachProject(kind);
                this.projects.delete(kind);
                this.save(true);
                if (this.refProject(kind) === name) this.toast("项目已删除，当前卡片仍保留在工作流里。");
            },
        });
    }

    // Project library browser: the video pools, with direct clip picking.
    openVideoLibrary(card) {
        const reset = name => Object.assign(card, { project: name, segment_id: null, key: "", view: null });
        openLibraryBrowser({
            scope: card.source, current: card.project, url: path => this.url(path),
            fetchJson: (path, options) => this.fetchJson(path, options),
            onUse: name => { if (name !== card.project) reset(name); this.save(true); },
            onPickClip: (name, record) => {
                Object.assign(card, { project: name, segment_id: record.segment_id, key: libraryKey(card.source, record) });
                card.view = this.viewFor(card, record);
                if (!card.name) card.name = card.view.title.replace(/\.[^.]+$/, "").slice(0, 60);
                this.libraries.delete(`${card.source}:${name}`);
                this.save(true);
            },
            onRenamed: (from, to) => {
                for (const item of this.doc.videos) if (item.source === card.source && item.project === from) item.project = to;
                this.projects.clear();
                this.libraries.clear();
                this.save(true);
            },
            onDeleted: (name, next) => { if (card.project === name) reset(next || DEFAULT_PROJECT); this.projects.delete(card.source); this.save(true); },
        });
    }

    async fillRefProjects(control, kind) {
        try {
            // Cached per kind; create / save / rename / delete drop the entry.
            if (!this.projects.has(kind)) {
                const request = this.fetchJson(`/amiaomiao_h3/lvm/projects?scope=${kind}`);
                request.catch(() => this.projects.delete(kind));
                this.projects.set(kind, request);
            }
            const data = await this.projects.get(kind);
            const project = this.refProject(kind);
            const rows = [...(data.projects || [])];
            if (!rows.some(row => row.name === project)) rows.push({ name: project, references: null });
            rows.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
            control.replaceChildren(...rows.map(row => {
                const option = el("option", "", row.references == null ? row.name : `${row.name}（${row.references}）`);
                option.value = row.name;
                return option;
            }));
            control.value = project;
        } catch {
            // keep the single current option
        }
    }

    // Inline create: the bar turns into a name field in place, no browser dialog.
    showCreateProject(bar, kind) {
        if (bar.classList.contains("is-creating")) return bar.querySelector(".ahr-create-input")?.focus();
        const noun = KIND_NAMES[kind];
        const saved = [...bar.children];
        const form = el("form", "ahr-create-form");
        const input = el("input", "ahr-name ahr-create-input");
        input.placeholder = `新${noun}项目名称`;
        input.maxLength = 80;
        input.setAttribute("aria-label", `新${noun}项目名称`);
        const confirm = textButton("建立", "check", () => {}, "is-confirm");
        confirm.type = "submit";
        confirm.disabled = true;
        const error = el("span", "ahr-create-error");
        const restore = () => {
            bar.classList.remove("is-creating");
            bar.replaceChildren(...saved);
            bar.querySelector(".ahr-icon-btn[aria-label^='新建']")?.focus();
        };
        const cancel = textButton("取消", "", () => restore());
        input.addEventListener("input", () => { confirm.disabled = !input.value.trim(); error.textContent = ""; });
        input.addEventListener("keydown", event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); restore(); }
        });
        form.addEventListener("submit", async event => {
            event.preventDefault();
            const typed = input.value.trim();
            if (!typed) return;
            confirm.disabled = true;
            const ok = await this.switchRefProject(kind, projectFolder(typed), { create: true });
            if (!ok && input.isConnected) {
                error.textContent = this.status.textContent;
                confirm.disabled = false;
                input.focus();
            }
        });
        const label = el("span", "ahr-project-label");
        label.append(icon("plus"), el("span", "", `新建${noun}项目`));
        form.append(input, confirm, cancel);
        bar.classList.add("is-creating");
        bar.replaceChildren(label, form, error);
        input.focus();
    }

    chooseProjectAction(kind, message, actions) {
        this.projectChoice = { kind, message, actions };
        this.render();
        this.body.querySelector(".ahr-project-choice button:last-child")?.focus();
    }

    renderProjectChoice() {
        const choice = this.projectChoice;
        const box = el("div", "ahr-clear-confirm ahr-project-choice");
        box.setAttribute("role", "group");
        box.setAttribute("aria-label", choice.message);
        const close = () => {
            this.projectChoice = null;
            this.render();
            this.body.querySelector(".ahr-project-select")?.focus();
        };
        box.append(el("span", "ahr-clear-text", choice.message));
        for (const [label, action] of choice.actions) {
            box.append(textButton(label, "", () => { close(); action(); }));
        }
        box.append(textButton("取消", "", close));
        box.addEventListener("keydown", event => {
            if (event.key === "Escape") { event.stopPropagation(); close(); }
        });
        return box;
    }

    async readRefProject(kind, project) {
        const data = await this.fetchJson(`/amiaomiao_h3/lvm/ref_presets?strict=1&kind=${kind}&project=${encodeURIComponent(project)}`);
        if (!(data.revision === null || typeof data.revision === "string") || !Array.isArray(data.references)) {
            throw new Error("无法读取项目，请重启 ComfyUI 后重试。");
        }
        return data;
    }

    async writeRefProject(kind, project, revision) {
        const result = await this.fetchJson("/amiaomiao_h3/lvm/ref_presets", { method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind, project, expected_revision: revision, entries: toPresetEntries(this.doc, kind) }) });
        if (typeof result.revision !== "string") throw new Error("保存响应无效，请重启 ComfyUI 后重试。");
        return result;
    }

    async runProjectAction(action) {
        if (this.projectOperation || this.disposed) return false;
        if (this.pendingImports) {
            this.toast("正在添加素材，请等上传完成后再操作项目。", true);
            return false;
        }
        const operation = {};
        const current = () => this.projectOperation === operation;
        this.projectChoice = null;
        this.body.querySelector(".ahr-project-choice")?.remove();
        this.projectOperation = operation;
        this.body.inert = true;
        this.body.setAttribute("aria-busy", "true");
        let result;
        try {
            result = await action(current);
        } catch (error) {
            if (current()) {
                this.projectOperation = null;
                this.body.inert = false;
                this.body.setAttribute("aria-busy", "false");
                this.toast(error.message, true);
            }
            return false;
        }
        if (!current()) return false;
        this.projectOperation = null;
        this.render();
        if (typeof result === "function") result();
        else if (result) this.toast(result);
        return true;
    }

    switchRefProject(kind, target, { refresh = false, create = false, decision } = {}) {
        if (this.projectOperation || this.disposed) return false;
        const source = this.refProject(kind);
        const binding = this.projectBinding(kind);
        const dirty = binding ? this.projectBaselines.get(kind) !== this.projectSignature(kind) :
            !!this.doc[`${kind}s`].length;
        if (!refresh && !create && target === source && binding) return false;
        if (dirty && !decision && (refresh || !binding)) {
            const proceed = choice => this.switchRefProject(kind, target, { refresh, create, decision: choice });
            const message = refresh ? "刷新会替换当前卡片和未保存的改动。" :
                `当前卡片尚未绑定项目。保存并切换会替换「${source}」中的卡片。`;
            this.chooseProjectAction(kind, message, refresh ? [
                ["放弃改动并刷新", () => proceed("discard")],
            ] : [
                ["保存并切换", () => proceed("save")],
                ["不保存，切换", () => proceed("discard")],
            ]);
            return true;
        }
        return this.runProjectAction(async current => {
            let data;
            if (!create) {
                data = await this.readRefProject(kind, target);
                if (!current()) return;
                if (!data.revision) throw new Error(`项目「${target}」不存在，当前卡片未更改。`);
            }
            if (!refresh && (decision === "save" || (binding && dirty && decision !== "discard"))) {
                const revision = binding ? binding.revision : (await this.readRefProject(kind, source)).revision;
                if (!current()) return;
                const saved = await this.writeRefProject(kind, source, revision);
                if (!current()) return;
                this.bindProject(kind, saved.name, saved.revision);
                this.projects.delete(kind);
                this.save();
                if (!create && target === source) data = await this.readRefProject(kind, target);
            }
            if (create) {
                const project = await this.fetchJson("/amiaomiao_h3/lvm/project", { method: "POST",
                    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: target, scope: kind }) });
                if (!current()) return;
                target = project.name || target;
                data = await this.readRefProject(kind, target);
            }
            if (!current()) return;
            if (!data.revision) throw new Error(`项目「${target}」不存在，当前卡片未更改。`);
            this.closePreview();
            this.stopAudio();
            this.results.clear();
            fromPresetEntries(this.doc, kind, data.references, target === source && !!binding);
            this.bindProject(kind, data.project_name || target, data.revision);
            this.projects.delete(kind);
            this.save();
            return `${refresh ? "已刷新" : "已切换到"}${KIND_NAMES[kind]}项目「${target}」：${data.references.length} 个`;
        });
    }

    saveRefProject(kind, expectedRevision) {
        const project = this.refProject(kind);
        const binding = this.projectBinding(kind);
        return this.runProjectAction(async current => {
            let revision = binding?.revision ?? expectedRevision;
            if (revision === undefined) {
                const data = await this.readRefProject(kind, project);
                if (!current()) return;
                revision = data.revision;
                if (data.references.length) {
                    const savedDoc = { [`${kind}s`]: this.doc[`${kind}s`] };
                    fromPresetEntries(savedDoc, kind, data.references, true);
                    if (this.projectSignature(kind, savedDoc) !== this.projectSignature(kind)) {
                        return () => this.chooseProjectAction(kind, `用当前卡片替换「${project}」里已保存的素材？`, [
                            ["确认保存", () => this.saveRefProject(kind, revision)],
                        ]);
                    }
                }
            }
            const saved = await this.writeRefProject(kind, project, revision);
            if (!current()) return;
            this.bindProject(kind, saved.name, saved.revision);
            this.projects.delete(kind);
            this.save();
            return `已保存到${KIND_NAMES[kind]}项目「${project}」`;
        });
    }

    addTile(kind, label, iconName, wide = false) {
        const tile = el("button", `ahr-add-tile${wide ? " is-wide" : ""}`);
        tile.type = "button";
        tile.append(icon(iconName), el("span", "ahr-add-label", label));
        if (kind !== "video") {
            tile.dataset.fileDrop = "";
            tile.append(el("span", "ahr-add-hint", "或拖入文件"));
        }
        tile.addEventListener("click", () => kind === "video" ? this.addVideo() : this.pickFiles(kind));
        return tile;
    }

    badge(card, kind) {
        const info = this.labels.get(card.id);
        const badge = el("span", `ahr-badge is-${kind}`, info ? info.display : "已停用");
        if (!info) badge.classList.add("is-off");
        if (info && kind === "video") {
            badge.append(el("span", `ahr-badge-sub${info.audioPort ? " is-on" : ""}`,
                ` · Video Audio ${info.audioPort ? "启用" : "未启用"}`));
        }
        return badge;
    }

    cardTools(card, kind, preview = null) {
        const tools = el("div", "ahr-card-tools");
        const toggle = textButton(card.skip ? "启用" : "停用", card.skip ? "play" : "pause",
            () => this.applyPlace(kind, card.id, !card.skip, Infinity), card.skip ? "is-enable" : "is-disable");
        toggle.title = card.skip ? "启用：加入输出并分配编号" : "停用：保留卡片，但不输出、不占编号";
        const remove = iconButton("trash", "移除卡片（文件不会被删除）", () => {
            removeCard(this.doc, kind, card.id);
            this.save(true);
        }, "is-danger");
        if (preview && this.root.dataset.density === "xlarge") {
            tools.append(iconButton(kind === "video" ? "play" : "expand", kind === "video" ? "播放视频" : "放大预览", preview));
        }
        tools.append(toggle, remove);
        return tools;
    }

    describeFields(card, kind) {
        const fields = el("div", "ahr-fields");
        const name = el("input", "ahr-name");
        name.value = card.name;
        name.placeholder = "名称";
        name.maxLength = 60;
        name.setAttribute("aria-label", "名称");
        name.addEventListener("input", () => { card.name = name.value; this.save(); });
        const purpose = select(PURPOSES[kind], card.purpose, value => { card.purpose = value; this.save(); }, "用途");
        const note = el("textarea", "ahr-note");
        note.value = card.note;
        note.rows = 2;
        note.placeholder = "描述（选填）";
        note.setAttribute("aria-label", "描述");
        note.addEventListener("input", () => { card.note = note.value; this.save(); });
        const row = el("div", "ahr-field-row");
        row.append(name, purpose);
        fields.append(row, note);
        return fields;
    }

    makeDraggable(node, card, kind) {
        // A draggable ancestor steals mouse text selection from its inputs, so the card only
        // becomes draggable for a press that starts outside form controls and buttons.
        const NO_DRAG = "input, textarea, select, button, label, [contenteditable]";
        node.draggable = false;
        node.dataset.id = card.id;
        node.addEventListener("pointerdown", event => {
            node.draggable = event.button === 0 && !event.target.closest(NO_DRAG);
        });
        node.addEventListener("pointerup", () => { node.draggable = false; });
        node.addEventListener("dragstart", event => {
            if (!node.draggable || event.target.closest?.(NO_DRAG)) return event.preventDefault();
            event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind, id: card.id }));
            event.dataTransfer.effectAllowed = "move";
            node.classList.add("is-dragging");
            this.dragKind = kind;
            this.root.dataset.dragging = kind;
        });
        node.addEventListener("dragend", () => {
            node.draggable = false;
            node.classList.remove("is-dragging");
            this.dragKind = null;
            delete this.root.dataset.dragging;
        });
        node.addEventListener("dragover", event => {
            if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = node.getBoundingClientRect();
            const after = kind === "image" ? event.clientX > rect.left + rect.width / 2
                : event.clientY > rect.top + rect.height / 2;
            node.dataset.drop = after ? "after" : "before";
        });
        node.addEventListener("dragleave", () => delete node.dataset.drop);
        node.addEventListener("drop", event => {
            const raw = event.dataTransfer.getData(DRAG_TYPE);
            const after = node.dataset.drop === "after";
            delete node.dataset.drop;
            if (!raw) return;
            event.preventDefault();
            event.stopPropagation();
            const moving = JSON.parse(raw);
            if (moving.kind !== kind || moving.id === card.id) return;
            const group = splitCards(this.doc, kind)[card.skip ? "parked" : "active"].filter(item => item.id !== moving.id);
            const index = group.findIndex(item => item.id === card.id) + (after ? 1 : 0);
            this.applyPlace(kind, moving.id, card.skip, index);
        });
    }

    imageCard(card) {
        const node = el("article", `ahr-card ahr-image-card${card.skip ? " is-skipped" : ""}`);
        const media = el("div", "ahr-image-media");
        const roomy = this.root.dataset.density === "xlarge";
        const preview = () => this.openPreview("image", this.fileUrl(card), card.name || card.filename);
        const image = el("img");
        image.alt = card.name || card.filename;
        image.loading = "lazy";
        image.draggable = false;
        if (roomy) image.addEventListener("load", () => {
            if (!image.naturalHeight) return;
            const aspect = Math.min(1, Math.max(2 / 3, image.naturalWidth / image.naturalHeight));
            media.style.aspectRatio = String(aspect);
        });
        image.src = this.fileUrl(card, "/amiaomiao_h3/lvm/image_thumbnail");
        image.addEventListener("error", () => { if (!image.dataset.fallback) { image.dataset.fallback = "1"; image.src = this.fileUrl(card); } });
        media.append(image, this.badge(card, "image"), this.cardTools(card, "image", preview));
        media.addEventListener("click", preview);
        const meta = el("div", "ahr-meta");
        const dim = el("span", "ahr-dim ahr-image-size");
        dim.dataset.cardId = card.id;
        const file = el("span", "ahr-file", card.filename);
        file.title = card.filename;
        meta.append(file, dim);
        this.updateImageSize(dim, card);
        node.append(media, this.describeFields(card, "image"), meta);
        this.makeDraggable(node, card, "image");
        return node;
    }

    updateImageSize(dim, card) {
        const url = this.fileUrl(card);
        const source = this.imageSizes.get(url);
        if (!source) {
            dim.textContent = "";
            if (!this.imageSizes.has(url)) {
                this.imageSizes.set(url, null);
                const probe = new Image();
                probe.onload = () => {
                    this.imageSizes.set(url, [probe.naturalWidth, probe.naturalHeight]);
                    this.refreshImageSizes();
                };
                probe.src = url;
            }
            return;
        }
        const out = planImageSize(source[0], source[1], this.settings.get("target_megapixels") ?? 0.25,
            !!this.settings.get("upscale_small_images"));
        const same = out && out[0] === source[0] && out[1] === source[1];
        dim.textContent = !out ? "" : same ? `${out[0]}×${out[1]}` : `${source[0]}×${source[1]} → ${out[0]}×${out[1]}`;
        dim.title = out ? `原图 ${source[0]}×${source[1]}\n输出 ${out[0]}×${out[1]}（${(out[0] * out[1] / 1e6).toFixed(2)} MP）` : "";
    }

    refreshImageSizes() {
        const cards = new Map(splitCards(this.doc, "image").active.concat(splitCards(this.doc, "image").parked).map(card => [card.id, card]));
        this.root?.querySelectorAll(".ahr-image-size").forEach(dim => {
            const card = cards.get(dim.dataset.cardId);
            if (card) this.updateImageSize(dim, card);
        });
    }

    audioCard(card) {
        const node = el("article", `ahr-card ahr-audio-card${card.skip ? " is-skipped" : ""}`);
        const top = el("div", "ahr-audio-top");
        const play = this.audioPreviewButton(card);
        const wave = el("canvas", "ahr-wave");
        wave.dataset.id = card.id;
        const waveBox = el("div", "ahr-wave-box");
        waveBox.append(wave, this.badge(card, "audio"));
        top.append(play, waveBox, this.cardTools(card, "audio"));
        const trim = el("div", "ahr-trim");
        for (const [field, label] of [["start", "开始（秒）"], ["duration", "时长（秒，0=到结尾）"]]) {
            const wrap = el("label", "ahr-trim-field");
            const input = el("input", "ahr-number");
            input.type = "number";
            input.step = "0.1";
            if (field === "duration") input.min = "0";
            input.value = String(card[field] || 0);
            input.addEventListener("change", () => {
                const value = Number(input.value);
                card[field] = Number.isFinite(value) && (field === "start" || value >= 0) ? value : 0;
                input.value = String(card[field]);
                this.save();
                this.drawWaveform(wave, card);
            });
            wrap.append(el("span", "", label), input);
            trim.append(wrap);
        }
        const info = el("span", "ahr-dim ahr-audio-info");
        info.dataset.info = card.id;
        trim.append(info);
        const meta = el("div", "ahr-meta");
        meta.append(el("span", "ahr-file", card.filename));
        node.append(top, trim, this.describeFields(card, "audio"), meta);
        this.makeDraggable(node, card, "audio");
        return node;
    }

    // Compact form: one row, easy to drag and to hit the buttons. Details stay in the card data.
    audioRow(card) {
        const node = el("article", `ahr-card ahr-audio-row${card.skip ? " is-skipped" : ""}`);
        const grip = el("span", "ahr-grip");
        grip.append(icon("bars"));
        grip.title = "拖动排序，拖到下方停用";
        const play = this.audioPreviewButton(card);
        const info = this.labels.get(card.id);
        const label = el("span", `ahr-row-label${info ? "" : " is-off"}`, info ? info.display : "停用");
        if (info) label.title = `接入 ${info.port}，提示词里写 ${info.label}`;
        const name = el("input", "ahr-name");
        name.value = card.name;
        name.placeholder = "名称";
        name.maxLength = 60;
        name.setAttribute("aria-label", "名称");
        name.addEventListener("input", () => { card.name = name.value; this.save(); });
        const purpose = select(PURPOSES.audio, card.purpose, value => { card.purpose = value; this.save(); }, "用途");
        const wave = el("canvas", "ahr-wave");
        wave.dataset.id = card.id;
        const waveBox = el("div", "ahr-wave-box is-mini");
        waveBox.append(wave);
        const range = el("span", "ahr-dim ahr-audio-info");
        range.dataset.info = card.id;
        const tools = this.cardTools(card, "audio");
        tools.classList.add("is-inline");
        node.append(grip, play, label, name, purpose, waveBox, range, tools);
        this.makeDraggable(node, card, "audio");
        return node;
    }

    // ---------- page 2: video ----------
    renderVideoPage(body) {
        const videos = this.section("video", "视频");
        videos.head.append(this.clearButton("video"), textButton("添加视频", "plus", () => this.addVideo()));
        videos.section.append(...this.zones("video", "ahr-video-list", card => this.videoCard(card),
            () => this.addTile("video", "添加视频", "video", true)));
        body.append(videos.section);
    }

    addVideo() {
        if (activeCount(this.doc, "video") >= LIMITS.video) return this.toast(`视频已达上限 ${LIMITS.video} 个`, true);
        addCards(this.doc, "video", [{ source: "segments", project: DEFAULT_PROJECT, segment_id: null,
            use_audio: false, max_side: 0 }]);
        this.doc.ui.page = "video";
        this.save(true);
    }

    videoCard(card) {
        const node = el("article", `ahr-card ahr-video-card${card.skip ? " is-skipped" : ""}`);
        const cover = el("div", "ahr-video-cover");
        const uploading = this.uploading?.get(card.id);
        const canPreview = !uploading && card.view?.video_url;
        const preview = () => this.openPreview("video", this.url(card.view.video_url), card.view.title);
        if (card.view?.cover_url) {
            const image = el("img");
            image.src = this.url(card.view.cover_url);
            image.alt = card.view.title || "";
            image.draggable = false;
            cover.append(image);
        } else if (card.source !== "uploads") {
            cover.append(el("div", "ahr-empty-cover", "未选择视频"));
        }
        if (uploading) {
            cover.classList.add("is-uploading");
            const busy = el("div", "ahr-upload-busy");
            busy.append(icon("spin pi-spinner"), el("span", "", uploading));
            cover.append(busy);
        } else if (card.source === "uploads") {
            this.makeUploadTarget(cover, card, !card.view?.cover_url);
        }
        if (canPreview) {
            const play = el("span", "ahr-cover-play");
            play.append(icon("play"));
            cover.append(play);
            cover.addEventListener("click", preview);
        }
        cover.append(this.badge(card, "video"), this.cardTools(card, "video", canPreview ? preview : null));

        const side = el("div", "ahr-video-side");
        const sourceRow = el("div", "ahr-pool");
        sourceRow.setAttribute("role", "radiogroup");
        sourceRow.setAttribute("aria-label", "视频池");
        for (const [value, label, hint, iconName] of [
            ["segments", "裁切片段池", "Long Video / Smart Split", "clone"],
            ["uploads", "投放视频池", "自己上传的完整视频", "upload"]]) {
            const option = el("button", "ahr-pool-option");
            option.type = "button";
            option.setAttribute("role", "radio");
            option.setAttribute("aria-checked", String(card.source === value));
            const text = el("span", "ahr-pool-text");
            text.append(el("strong", "", label), el("small", "", hint));
            option.append(icon(iconName), text);
            option.addEventListener("click", () => {
                if (card.source === value) return;
                Object.assign(card, { source: value, segment_id: null, key: "", view: null });
                this.save(true);
            });
            sourceRow.append(option);
        }
        const libraryRow = el("div", "ahr-field-row");
        const projectSelect = select([[card.project, card.project]], card.project, value => {
            Object.assign(card, { project: value, segment_id: null, key: "", view: null });
            this.save(true);
        }, "素材库");
        this.fillProjects(projectSelect, card);
        const poolName = card.source === "uploads" ? "投放视频" : "裁切片段";
        const browse = textButton("浏览", "folder-open", () => this.openVideoLibrary(card), "is-library");
        browse.title = `打开${poolName}库（封面、内容预览、重命名、删除）`;
        browse.setAttribute("aria-label", `打开${poolName}库`);
        libraryRow.append(projectSelect, browse, iconButton("refresh", "刷新素材库", () => {
            this.libraries.delete(`${card.source}:${card.project}`);
            this.projects.delete(card.source);
            this.render();
        }));
        if (card.source === "uploads") libraryRow.append(iconButton("upload", "投放新视频", () => this.uploadVideo(card)));
        const strip = el("div", "ahr-strip");
        this.fillStrip(strip, card);
        const options = el("div", "ahr-video-options");
        const audioToggle = el("label", "ahr-toggle");
        const checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.checked = !!card.use_audio;
        // A video without a soundtrack would send silence and still take an <Audio j> number.
        const silent = card.view?.has_audio === false;
        if (silent && !card.use_audio) {
            checkbox.disabled = true;
            audioToggle.classList.add("is-disabled");
            audioToggle.title = "这段视频没有音轨";
        } else if (silent) {
            audioToggle.classList.add("is-warning");
            audioToggle.title = "这段视频没有音轨，开启只会送入静音，建议关闭";
        }
        checkbox.addEventListener("change", () => { card.use_audio = checkbox.checked; this.save(true); });
        audioToggle.append(checkbox, el("span", "ahr-switch"), el("span", "", "Video Audio"));
        options.append(audioToggle);
        if (card.source === "uploads") {
            const current = card.max_side || 0;
            const known = VIDEO_SIZES.some(([value]) => value === current);
            const preset = this.customVideoSides.has(card.id) || !known ? "custom" : current;
            options.append(select(VIDEO_SIZES, preset, value => {
                if (value === "custom") {
                    this.customVideoSides.add(card.id);
                    card.max_side = customVideoSide(current || 1024);
                } else {
                    this.customVideoSides.delete(card.id);
                    card.max_side = Number(value);
                }
                this.save(true);
            }, "输出尺寸"));
            if (preset === "custom") {
                const custom = el("input", "ahr-number ahr-video-side-number");
                Object.assign(custom, { type: "number", min: "64", max: "8192", step: "32", value: String(card.max_side) });
                custom.setAttribute("aria-label", "自定义最长边");
                custom.title = "最长边（像素），按 32 对齐";
                custom.addEventListener("change", () => {
                    card.max_side = customVideoSide(custom.value);
                    this.save(true);
                });
                const [width, height] = decodedVideoSize(card.view?.width, card.view?.height, card.max_side);
                const output = width && height ? `输出 ${width}×${height}` : "选择视频后显示输出尺寸";
                options.append(custom, el("span", "ahr-dim", "px"), el("span", "ahr-video-output-size", output));
            }
        }
        const result = this.results.get(card.id);
        const facts = [card.view?.facts, result?.frames ? `${result.frames} 帧 · ${result.size[0]}×${result.size[1]}` : ""].filter(Boolean).join(" · ");
        options.append(el("span", "ahr-dim", facts));
        side.append(sourceRow, libraryRow, strip, options, this.describeFields(card, "video"));
        node.append(cover, side);
        this.makeDraggable(node, card, "video");
        return node;
    }

    async fetchJson(path, options) {
        const response = await this.api.fetchApi(path, { cache: "no-store", ...options });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
        return data;
    }

    async fillProjects(control, card) {
        try {
            if (!this.projects.has(card.source)) {
                this.projects.set(card.source, this.fetchJson(`/amiaomiao_h3/lvm/projects?scope=${card.source}`));
            }
            const data = await this.projects.get(card.source);
            const names = (data.projects || []).map(row => row.name);
            if (!names.includes(card.project)) names.unshift(card.project);
            control.replaceChildren(...names.map(name => {
                const option = el("option", "", name);
                option.value = name;
                return option;
            }));
            control.value = card.project;
        } catch (error) {
            this.projects.delete(card.source);
        }
    }

    library(card) {
        const key = `${card.source}:${card.project}`;
        if (!this.libraries.has(key)) {
            const path = card.source === "uploads"
                ? `/amiaomiao_h3/lvm/uploads?project=${encodeURIComponent(card.project)}`
                : `/amiaomiao_h3/lvm/segments?project=${encodeURIComponent(card.project)}`;
            const request = this.fetchJson(path).then(data => (card.source === "uploads" ? data.videos : data.segments) || []);
            request.catch(() => this.libraries.delete(key));
            this.libraries.set(key, request);
        }
        return this.libraries.get(key);
    }

    viewFor(card, item) {
        const seconds = Number(item.duration_sec) || (item.frames ? item.frames / (item.fps || 24) : 0);
        const size = item.width && item.height ? `${item.width}×${item.height}` : "";
        return {
            title: item.original_name || item.label || item.tag || `#${item.segment_id}`,
            cover_url: item.cover_url || item.thumbnail_url || "",
            video_url: card.source === "uploads" ? (item.browser_preview ? item.video_url : "") : (item.mp4_url || ""),
            has_audio: item.has_audio == null ? null : !!item.has_audio,
            width: Number(item.width) || 0,
            height: Number(item.height) || 0,
            facts: [seconds ? `${seconds.toFixed(1)} 秒` : "", size, item.has_audio ? "有声" : "无声"].filter(Boolean).join(" · "),
        };
    }

    async fillStrip(strip, card) {
        strip.append(el("div", "ahr-strip-note", "读取中…"));
        let items;
        try {
            items = await this.library(card);
        } catch (error) {
            strip.replaceChildren(el("div", "ahr-strip-note is-error", error.message));
            return;
        }
        let lost = false;
        if (card.segment_id) {
            const { record, moved } = matchLibrary(card, items);
            if (!record) {
                lost = true;
            } else if (moved || !card.key || !card.view || card.view.has_audio === undefined
                    || !card.view.width || !card.view.height) {
                const note = record.segment_id !== card.segment_id
                    ? `素材库编号已变化，已找回原视频（#${card.segment_id} → #${record.segment_id}）` : "";
                card.segment_id = record.segment_id;
                card.key = libraryKey(card.source, record);
                card.view = this.viewFor(card, record);
                this.save(true);
                if (note) this.toast(note);
                return;
            }
        }
        if (!items.length) {
            strip.replaceChildren(el("div", "ahr-strip-note", card.source === "uploads" ? "这个素材库还没有视频" : "这个素材库还没有裁切片段"));
            return;
        }
        const options = items.map(item => {
            const option = el("div", "ahr-strip-item");
            option.setAttribute("role", "button");
            option.tabIndex = 0;
            option.title = this.viewFor(card, item).title;
            option.setAttribute("aria-pressed", String(!lost && item.segment_id === card.segment_id));
            const cover = item.cover_url || item.thumbnail_url;
            if (cover) {
                const image = el("img");
                image.src = this.url(cover);
                image.alt = "";
                image.loading = "lazy";
                image.draggable = false;
                option.append(image);
            }
            option.append(el("span", "ahr-strip-id", `#${item.segment_id}`));
            const choose = () => {
                card.segment_id = item.segment_id;
                card.key = libraryKey(card.source, item);
                card.view = this.viewFor(card, item);
                if (!card.name) card.name = card.view.title.replace(/\.[^.]+$/, "").slice(0, 60);
                this.save(true);
            };
            option.addEventListener("click", choose);
            option.addEventListener("keydown", event => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); }
            });
            if (card.source === "uploads") {
                const remove = iconButton("trash", "从投放视频库删除", () => this.confirmDeleteUpload(option, card, item), "is-danger ahr-strip-delete");
                option.append(remove);
            }
            return option;
        });
        strip.replaceChildren(...(lost ? [el("div", "ahr-strip-note is-error", "原来选的视频已不在库中，请重新选择")] : []), ...options);
        const chosen = strip.querySelector('[aria-pressed="true"]');
        if (chosen) strip.scrollLeft = Math.max(0, chosen.offsetLeft - (strip.clientWidth - chosen.offsetWidth) / 2);
    }

    confirmDeleteUpload(option, card, item) {
        const confirm = el("div", "ahr-strip-confirm");
        confirm.setAttribute("role", "group");
        confirm.setAttribute("aria-label", "确认删除投放视频");
        const yes = textButton("删除", "trash", () => this.deleteUpload(card, item), "is-danger-solid");
        const no = textButton("取消", "", () => confirm.remove());
        confirm.append(yes, no);
        confirm.addEventListener("click", event => event.stopPropagation());
        confirm.addEventListener("keydown", event => {
            event.stopPropagation();
            if (event.key === "Escape") confirm.remove();
        });
        option.querySelector(".ahr-strip-confirm")?.remove();
        option.append(confirm);
        no.focus();
    }

    async deleteUpload(card, item) {
        try {
            await this.fetchJson("/amiaomiao_h3/lvm/uploads/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ project: card.project, segment_id: item.segment_id }),
            });
            const deletedKey = libraryKey("uploads", item);
            for (const video of this.doc.videos) {
                if (video.source !== "uploads" || video.project !== card.project) continue;
                if (video.key === deletedKey || (!video.key && video.segment_id === item.segment_id)) {
                    Object.assign(video, { segment_id: 0, key: "", view: null });
                }
            }
            this.libraries.delete(`uploads:${card.project}`);
            this.projects.delete("uploads");
            this.save(true);
            this.toast("已从投放视频库删除");
        } catch (error) {
            this.toast(`删除失败：${error.message}`, true);
        }
    }

    uploadVideo(card) {
        const input = el("input");
        input.type = "file";
        input.accept = "video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v";
        input.addEventListener("change", () => { if (input.files?.[0]) this.importVideo(card, input.files[0]); });
        input.click();
    }

    // The cover of an upload-pool card is where a video goes: click to pick, or drop a file.
    makeUploadTarget(cover, card, empty) {
        cover.classList.add("is-upload-target");
        if (empty) {
            const hint = el("div", "ahr-upload-hint");
            hint.append(icon("upload"), el("strong", "", "投放视频"), el("small", "", "点击选择，或把视频拖到这里"));
            cover.append(hint);
            cover.addEventListener("click", () => this.uploadVideo(card));
            cover.setAttribute("role", "button");
            cover.tabIndex = 0;
            cover.setAttribute("aria-label", "投放视频");
            cover.addEventListener("keydown", event => {
                if (event.target === cover && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); this.uploadVideo(card); }
            });
        } else {
            const replace = el("div", "ahr-upload-replace");
            replace.append(icon("upload"), el("span", "", "松开即投放并替换"));
            cover.append(replace);
        }
        cover.dataset.fileDrop = "";
        cover.addEventListener("dragover", event => {
            if (!event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "copy";
        });
        cover.addEventListener("drop", event => {
            if (!event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();
            event.stopPropagation();
            const file = [...event.dataTransfer.files].find(item => mediaKind(item.name) === "video");
            if (!file) return this.toast("这里只能放视频文件（mp4 / mov / mkv / webm / avi / m4v）", true);
            this.importVideo(card, file);
        });
    }

    async importVideo(card, file) {
        if (this.uploading?.has(card.id)) return;
        this.uploading ||= new Map();
        this.uploading.set(card.id, `正在投放 ${file.name}`);
        this.render();
        let message = "已投放", failed = false;
        try {
            const form = new FormData();
            form.append("project", card.project);
            form.append("file", file);
            const record = await this.fetchJson("/amiaomiao_h3/lvm/uploads/import", { method: "POST", body: form });
            this.libraries.delete(`uploads:${card.project}`);
            this.projects.delete("uploads");
            const items = await this.library(card);
            const item = items.find(row => row.segment_id === record.segment_id) || record;
            card.segment_id = record.segment_id;
            card.key = libraryKey(card.source, item);
            card.view = this.viewFor(card, item);
            if (!card.name) card.name = nameFromFile(file.name);
        } catch (error) {
            message = error.message;
            failed = true;
        } finally {
            this.uploading.delete(card.id);
            this.save(true);  // re-render first: render() replaces the toast element
            this.toast(message, failed);
        }
    }

    // ---------- files ----------
    pickFiles(kind) {
        const input = el("input");
        input.type = "file";
        input.multiple = true;
        input.accept = kind === "image" ? "image/*" : "audio/*,.wav,.mp3,.m4a,.flac,.ogg,.opus";
        input.addEventListener("change", () => this.importFiles([...input.files], kind));
        input.click();
    }

    async importFiles(files, forcedKind) {
        if (this.projectOperation || this.disposed) {
            this.toast("项目正在切换，请稍后再添加素材。", true);
            return;
        }
        this.pendingImports += 1;
        try {
            await this.importReferenceFiles(files, forcedKind, this.doc);
        } finally {
            this.pendingImports -= 1;
        }
    }

    async importReferenceFiles(files, forcedKind, doc) {
        const groups = { image: [], audio: [] };
        let ignored = 0;
        for (const file of files) {
            const kind = forcedKind || mediaKind(file.name);
            if (groups[kind]) groups[kind].push(file); else ignored += 1;
        }
        let added = 0, parked = 0;
        for (const kind of ["image", "audio"]) {
            const cards = [];
            for (const file of groups[kind]) {
                if (this.disposed || this.doc !== doc) return;
                try {
                    cards.push(await this.uploadFile(file, kind));
                } catch (error) {
                    this.toast(error.message, true);
                }
            }
            if (this.disposed || this.doc !== doc) return;
            if (cards.length) {
                parked += addCards(this.doc, kind, cards);
                added += cards.length;
            }
        }
        if (added) {
            // Stay on the current page if it received files; otherwise show where they went.
            if (!groups[this.doc.ui.page]?.length) this.doc.ui.page = groups.image.length ? "image" : "audio";
            this.save(true);
            this.toast(parked ? `已添加 ${added} 个，其中 ${parked} 个超出上限已停用` : `已添加 ${added} 个`);
        } else if (ignored) {
            this.toast("视频请拖到「投放视频池」视频卡的左侧封面区", true);
        }
    }

    async uploadFile(file, kind) {
        const form = new FormData();
        const subfolder = `${UPLOAD_ROOT}/${kind}/${projectFolder(this.refProject(kind))}`;
        form.append("image", file);
        form.append("subfolder", subfolder);
        form.append("type", "input");
        const response = await this.api.fetchApi("/upload/image", { method: "POST", body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.name) throw new Error(`上传失败：${file.name}`);
        const card = { filename: data.name, subfolder: data.subfolder || subfolder, type: data.type || "input",
            name: nameFromFile(file.name) };
        if (kind === "audio") Object.assign(card, { start: 0, duration: 0 });
        return card;
    }

    setFileHover(target = null) {
        if (this.fileHoverTarget !== target) {
            this.fileHoverTarget?.classList.remove("is-drop");
            this.fileHoverTarget = target;
            if (target !== this.root) target?.classList.add("is-drop");
        }
        this.root.classList.toggle("is-file-over", target === this.root);
    }

    bindDrop() {
        const updateHover = event => {
            if (!event.dataTransfer?.types.includes("Files")) return;
            const target = event.target.closest?.("[data-file-drop]");
            this.setFileHover(target && this.root.contains(target) ? target : this.root);
        };
        // Capture the visual state before the video cover handles its own drop.
        this.root.addEventListener("dragenter", updateHover, true);
        this.root.addEventListener("dragover", updateHover, true);
        this.root.addEventListener("drop", () => this.setFileHover(), true);
        this.root.addEventListener("dragover", event => {
            if (!event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();
            event.stopPropagation();
        });
        this.root.addEventListener("dragleave", event => {
            if (!this.root.contains(event.relatedTarget)) this.setFileHover();
        });
        this.root.addEventListener("drop", event => {
            if (!event.dataTransfer?.files?.length) return;
            event.preventDefault();
            event.stopPropagation();
            this.importFiles([...event.dataTransfer.files]);
        });
    }

    // ---------- audio ----------
    async peaks(card) {
        const key = `${card.type}/${card.subfolder}/${card.filename}`;
        if (!peakCache.has(key)) {
            peakCache.set(key, (async () => {
                const response = await fetch(this.fileUrl(card));
                const buffer = await response.arrayBuffer();
                const context = new (window.AudioContext || window.webkitAudioContext)();
                try {
                    const audio = await context.decodeAudioData(buffer);
                    const data = audio.getChannelData(0);
                    const bins = 240, size = Math.max(1, Math.floor(data.length / bins));
                    const values = [];
                    for (let i = 0; i < bins; i++) {
                        let peak = 0;
                        for (let j = i * size; j < Math.min(data.length, (i + 1) * size); j += 16) peak = Math.max(peak, Math.abs(data[j]));
                        values.push(peak);
                    }
                    return { values, duration: audio.duration, rate: audio.sampleRate, channels: audio.numberOfChannels };
                } finally {
                    context.close?.();
                }
            })());
            peakCache.get(key).catch(() => peakCache.delete(key));
        }
        return peakCache.get(key);
    }

    drawWaveforms() {
        for (const canvas of this.root.querySelectorAll("canvas.ahr-wave")) {
            const card = this.doc.audios.find(item => item.id === canvas.dataset.id);
            if (card) this.drawWaveform(canvas, card);
        }
    }

    async drawWaveform(canvas, card) {
        let data;
        try { data = await this.peaks(card); } catch { return; }
        if (!canvas.isConnected) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        const context = canvas.getContext("2d");
        const { start, end } = trimWindow(data.duration, card.start, card.duration);
        const width = canvas.width, height = canvas.height, bar = width / data.values.length;
        context.clearRect(0, 0, width, height);
        const loudest = Math.max(0.05, ...data.values);
        data.values.forEach((value, index) => {
            const time = (index + 0.5) / data.values.length * data.duration;
            context.fillStyle = time >= start && time <= end ? "#f0b45a" : "#5b4a33";
            const h = Math.max(2 * ratio, value / loudest * height * 0.8);
            context.fillRect(index * bar + bar * 0.15, (height - h) / 2, Math.max(1, bar * 0.7), h);
        });
        const info = this.root.querySelector(`[data-info="${card.id}"]`);
        if (info) info.textContent = info.closest(".ahr-audio-row")
            ? `${formatSeconds(start)}–${formatSeconds(end)}`
            : `全长 ${formatSeconds(data.duration)} · 使用 ${formatSeconds(start)}–${formatSeconds(end)}`;
    }

    audioPreviewButton(card) {
        const active = this.audio && this.previewAudioId === card.id;
        const button = iconButton(active ? "pause" : "play", "试听", () => this.toggleAudio(card, button), "is-play");
        if (active) this.previewAudioButton = button;
        return button;
    }

    stopAudio() {
        const audio = this.audio;
        if (!audio) return;
        const button = this.previewAudioButton;
        // Invalidate callbacks before pausing or releasing the source.
        this.audio = null;
        this.previewAudioId = null;
        this.previewAudioButton = null;
        if (button) button.firstChild.className = "pi pi-play";
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
    }

    toggleAudio(card, button) {
        const sameCard = this.previewAudioId === card.id;
        this.stopAudio();
        if (sameCard) return;

        const audio = new Audio();
        this.audio = audio;
        this.previewAudioId = card.id;
        this.previewAudioButton = button;
        button.firstChild.className = "pi pi-pause";

        const finish = (failed = false) => {
            if (this.audio !== audio) return;
            this.stopAudio();
            if (failed) this.toast("试听失败：无法播放这条音频", true);
        };
        audio.addEventListener("loadedmetadata", () => {
            if (this.audio !== audio) return;
            const { start, end } = trimWindow(audio.duration, card.start, card.duration);
            audio.currentTime = start;
            audio.addEventListener("timeupdate", () => { if (audio.currentTime >= end) finish(); });
            audio.play().catch(() => finish(true));
        }, { once: true });
        audio.addEventListener("pause", () => finish());
        audio.addEventListener("ended", () => finish());
        audio.addEventListener("error", () => finish(true));
        audio.src = this.fileUrl(card);
    }

    // ---------- preview & manifest ----------
    openPreview(kind, src, title) {
        this.closePreview();
        const overlay = el("div", "ahr-preview");
        const frame = el("div", "ahr-preview-frame");
        const head = el("div", "ahr-preview-head");
        head.append(el("span", "", title || ""), iconButton("times", "关闭", () => this.closePreview()));
        const media = kind === "video" ? el("video") : el("img");
        media.src = src;
        if (kind === "video") { media.controls = true; media.autoplay = true; }
        frame.append(head, media);
        overlay.append(frame);
        overlay.addEventListener("click", event => { if (event.target === overlay) this.closePreview(); });
        this.escape = event => { if (event.key === "Escape") this.closePreview(); };
        document.addEventListener("keydown", this.escape);
        document.body.append(overlay);
        this.preview = overlay;
    }

    closePreview() {
        this.preview?.querySelector("video")?.pause();
        this.preview?.remove();
        this.preview = null;
        if (this.escape) document.removeEventListener("keydown", this.escape);
        this.escape = null;
    }

    async copyManifest() {
        const text = manifestText(this.doc);
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            const area = el("textarea");
            area.value = text;
            document.body.append(area);
            area.select();
            document.execCommand("copy");
            area.remove();
        }
        this.toast("素材清单已复制");
    }

    showResults(message) {
        const items = message?.h3_refs?.[0]?.items || [];
        this.results = new Map(items.map(item => [item.id, item]));
        if (this.isTyping()) { this.pendingRender = true; return; }
        this.render();
    }
}

export { newId };
