// Panels for「H3 片段选择 v2」and「H3 片段保存 v2」, built from the「H3 参考素材」components
// (see UI_GUIDE.md). The picker edits the node's own hidden widgets (project_name, mode,
// clip_selection, passes and continuation settings), so saved workflows keep their values in place.
import { openLibraryBrowser, relativeTime, fullTime } from "./library_browser.js";
import { CARD_DENSITIES, normalizeCardDensity } from "./refs_state.js";
import { AUDIO_LENGTH_MAX, CONTEXT_LENGTHS, FLOW_DUAL, FLOW_SINGLE, LATEST, MODE_CONTINUE, MODE_NEW, PASS_ONE, PASS_TWO,
    chainOf, isLatest, normalizeContext, normalizeMode, normalizePasses, parentLabel, plannedStatus,
    resolutionOf, shotLabel, splitStageCards, variantsOf } from "./clip_state.js";

const DENSITY_KEY = "amiaomiao.clipv2.density";

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
    const node = el("button", `ahr-icon-btn ${className}`.trim());
    node.type = "button";
    node.title = title;
    node.setAttribute("aria-label", title);
    node.append(icon(name));
    node.addEventListener("click", event => { event.stopPropagation(); onClick(event); });
    return node;
}
function textButton(label, iconName, onClick, className = "") {
    const node = el("button", `ahr-btn ${className}`.trim());
    node.type = "button";
    if (iconName) node.append(icon(iconName));
    node.append(el("span", "", label));
    node.addEventListener("click", event => { event.stopPropagation(); onClick(event); });
    return node;
}
// The reference hub's two-way chooser: icon + bold name + one line of explanation.
function poolChooser(label, options, value, onPick, className = "") {
    const group = el("div", `ahr-pool ${className}`.trim());
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    for (const [key, name, hint, glyph, tip] of options) {
        const option = el("button", "ahr-pool-option");
        option.type = "button";
        option.setAttribute("role", "radio");
        option.setAttribute("aria-checked", String(key === value));
        option.setAttribute("aria-label", name);
        option.dataset.value = key;
        if (tip) option.title = tip;
        const text = el("span", "ahr-pool-text");
        text.append(el("strong", "", name), el("small", "", hint));
        option.append(icon(glyph), text);
        option.addEventListener("click", () => { if (key !== value) onPick(key); });
        group.append(option);
    }
    return group;
}
function readDensity() {
    try { return normalizeCardDensity(localStorage.getItem(DENSITY_KEY)); } catch { return "large"; }
}

export class ClipPickerPanel {
    // fields: { get(name), set(name, value) } bound to the node widgets. fetchJson(path, options), url(path).
    constructor({ fields, fetchJson, url, stageWorkflow = false }) {
        this.fields = fields;
        this.fetchJson = fetchJson;
        this.url = url || (path => path);
        this.stageWorkflow = stageWorkflow;
        this.clips = [];
        this.drafts = [];
        this.page = "complete";
        this.projects = null;
        this.loading = true;
        this.error = "";
        this.lastRun = null;
        this.density = readDensity();
        this.view = "all";          // all | chain (only the chain the next run continues)
        this.batch = false;         // batch lock / delete mode
        this.marked = new Set();
        this.root = el("div", "ahr ahc");
        this.root.tabIndex = -1;
        // one toast for the panel's lifetime, so a re-render does not swallow a message
        this.status = el("div", "ahr-toast");
        this.status.setAttribute("role", "status");
        this.request = 0;
        this.root.addEventListener("dblclick", event => {
            const node = event.target.closest?.(".ahc-card[data-clip-id]");
            if (!node || this.batch || event.target.closest("button, input, .ahr-clear-confirm")) return;
            const clip = this.cards.find(c => c.clip_id === node.dataset.clipId);
            if (!clip) return;
            const before = this.beforeClick;
            if (before && Date.now() - before.at < 800) {
                this.fields.set("mode", before.mode);
                this.fields.set("clip_selection", before.selection);
                this.status.classList.remove("is-visible");
                this.render();
            }
            this.beforeClick = null;
            this.openDetail(clip);
        });
        this.render();
        this.reload();
    }

    get project() { return String(this.fields.get("project_name") || "Default_Project"); }
    get mode() { return normalizeMode(this.fields.get("mode")); }
    get passes() { return normalizePasses(this.fields.get("passes")); }
    get selection() { return String(this.fields.get("clip_selection") ?? LATEST); }
    get dualStage() { return this.stageWorkflow && this.passes === FLOW_DUAL; }
    get assetKind() { return !this.stageWorkflow ? "v2" : this.dualStage ? "stage_dual" : "stage_single"; }
    get refineId() { return this.dualStage ? String(this.fields.get("refine_clip") || "") : ""; }
    get cards() { return [...this.clips, ...this.drafts]; }
    get draftPage() { return this.dualStage && this.page === "draft"; }
    get context() {
        return normalizeContext(this.fields.get("context_length"), this.fields.get("enable_audio_context"),
            this.fields.get("audio_context_length"));
    }

    set(name, value) {
        this.fields.set(name, value);
        this.render();
    }

    clearRefine() {
        this.fields.set("refine_clip", "");
        this.fields.set("refine_revision", "");
    }

    openPage(page) {
        this.page = page;
        this.batch = false;
        this.marked.clear();
        this.render();
    }

    chooseRefine(clip) {
        this.fields.set("refine_clip", clip.clip_id);
        this.fields.set("refine_revision", clip.stage_revision);
        this.render();
    }

    saved(info) {
        if (!this.stageWorkflow) return;
        const folder = name => String(name || "").replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "Default_Project";
        if (info.project && folder(info.project) !== folder(this.project)) return;
        if (info.stage === "first" && this.dualStage && !this.refineId && !this.openedDraftOnSave) {
            this.openedDraftOnSave = true;
            this.openPage("draft");
        }
        if (info.stage === "second" && this.refineId === info.clip_id) {
            this.clearRefine();
            this.openPage("complete");
        }
        this.lastRun = info;
        this.reload({ projects: true });
    }

    // What the next run continues from, or null. Only meaningful in 接续前段.
    target() {
        if (this.mode !== MODE_CONTINUE) return null;
        if (isLatest(this.selection)) return this.clips[0] || null;
        return this.clips.find(c => c.clip_id === this.selection) || null;
    }

    // Picking a clip always means "continue from this one":
    //  - in 全新段落 it switches back to 接续前段;
    //  - picking the newest while following keeps following (nothing would change, and silently
    //    pinning would make the next run branch off once a newer clip is saved);
    //  - anything else pins that clip.
    pick(clip) {
        const following = isLatest(this.selection);
        const wasNew = this.mode !== MODE_CONTINUE;
        if (wasNew) this.fields.set("mode", MODE_CONTINUE);
        if (following && clip === this.clips[0]) {
            this.render();
            this.toast(wasNew ? `已切到接续前段，跟随最新：${shotLabel(clip)}`
                : `正在跟随最新（${shotLabel(clip)}）。要固定它，关掉“跟随最新”`);
            return;
        }
        this.set("clip_selection", clip.clip_id);
        if (wasNew) this.toast(`已切到接续前段，固定：${shotLabel(clip)}`);
    }

    setFollow(on) {
        if (this.mode !== MODE_CONTINUE) this.fields.set("mode", MODE_CONTINUE);
        if (on) return this.set("clip_selection", LATEST);
        const newest = this.clips[0];
        if (newest) this.set("clip_selection", newest.clip_id);  // pin what is newest now
        else this.render();
    }

    toast(message, error = false) {
        if (!this.status) return;
        this.status.textContent = message;
        this.status.classList.toggle("is-error", error);
        this.status.classList.add("is-visible");
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => this.status?.classList.remove("is-visible"), 2600);
    }

    async reload({ projects = false, restorePage = false } = {}) {
        const id = ++this.request;
        if (projects) this.projects = null;
        try {
            const data = await this.fetchJson(`/amiaomiao_h3/clip_bin/list?project=${encodeURIComponent(this.project)}&asset_kind=${this.assetKind}`);
            if (id !== this.request) return;
            const { drafts, completed } = splitStageCards(data.clips || []);
            this.clips = completed;
            this.drafts = drafts;
            if (restorePage && this.refineId) this.page = drafts.some(c => c.clip_id === this.refineId) ? "draft" : "complete";
            this.error = "";
        } catch (error) {
            if (id !== this.request) return;
            this.clips = [];
            this.drafts = [];
            this.error = error.message;
        }
        this.loading = false;
        this.render();
    }

    showResult(message) {
        const info = message?.h3_clip_v2?.[0];
        if (info) this.lastRun = info;
        this.reload({ projects: true });
    }

    dispose() {
        clearTimeout(this.toastTimer);
        document.querySelector(".ahc-modal")?._close?.();
    }

    // ---------- layout (same shell as the reference hub) ----------
    render() {
        // never rebuild under a text field being typed in (a focused checkbox is fine)
        if (this.root.contains(document.activeElement)
            && document.activeElement.matches?.("input:not([type=checkbox]):not([type=radio]), textarea")) return;
        const scroll = this.body?.scrollTop || 0;
        this.root.replaceChildren();
        this.root.dataset.density = this.density;
        this.body = el("div", "ahr-body");
        // setup (library + workflow) first, then this run (mode -> plan -> which clip)
        this.body.append(this.projectBar(), this.flowLine(), this.runSection());
        this.root.append(this.header(), this.body, this.status);
        this.body.scrollTop = scroll;
    }

    header() {
        const header = el("div", "ahr-header");
        const title = el("div", "ahr-title");
        title.append(icon("video"), el("span", "", this.stageWorkflow ? "H3 片段选择 v2" : "H3 片段选择 v1"));
        const actions = el("div", "ahr-actions");
        const density = el("div", "ahr-density");
        density.setAttribute("role", "group");
        density.setAttribute("aria-label", "卡片尺寸");
        for (const [value, glyph, label] of CARD_DENSITIES) {
            const option = iconButton(glyph, label, () => {
                if (this.density === value) return;
                this.density = value;
                try { localStorage.setItem(DENSITY_KEY, value); } catch { /* optional */ }
                this.root.dataset.density = value;
                for (const child of density.children) child.setAttribute("aria-pressed", String(child.dataset.value === value));
            }, "is-seg");
            option.dataset.value = value;
            option.setAttribute("aria-pressed", String(this.density === value));
            density.append(option);
        }
        actions.append(density);
        header.append(title, actions);
        return header;
    }

    // Same project bar as the image / audio pages: label, dropdown, 浏览, 新建, 刷新.
    projectBar() {
        const bar = el("div", "ahr-project-bar is-video");
        const label = el("span", "ahr-project-label");
        label.append(icon("folder"), el("span", "", this.stageWorkflow ? (this.dualStage ? "双采项目库" : "单采项目库") : "片段项目库"));
        const control = el("select", "ahr-select ahr-project-select");
        control.setAttribute("aria-label", "片段项目库");
        const current = el("option", "", this.project);
        current.value = this.project;
        control.append(current);
        control.addEventListener("change", () => this.switchProject(control.value));
        this.fillProjects(control);
        const browse = textButton("浏览", "folder-open", () => this.openLibrary(), "is-library");
        browse.title = "打开片段项目库（封面、内容预览、重命名、删除）";
        browse.setAttribute("aria-label", "打开片段项目库");
        const create = iconButton("plus", "新建片段项目", () => this.showCreateProject(bar));
        const refresh = iconButton("refresh", "刷新片段", () => this.reload({ projects: true }));
        bar.append(label, control, browse, create, refresh);
        return bar;
    }

    async fillProjects(control) {
        try {
            if (!this.projects) {
                this.projects = this.fetchJson(`/amiaomiao_h3/clip_bin/projects?asset_kind=${this.stageWorkflow ? this.assetKind : ""}`);
                this.projects.catch(() => { this.projects = null; });
            }
            const data = await this.projects;
            const rows = [...(data.projects || [])];
            if (!rows.some(row => row.name === this.project)) rows.push({ name: this.project, clips: null });
            rows.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
            control.replaceChildren(...rows.map(row => {
                const option = el("option", "", row.clips == null ? row.name : `${row.name}（${row.clips}）`);
                option.value = row.name;
                return option;
            }));
            control.value = this.project;
        } catch {
            // keep the single current option
        }
    }

    // Inline create, exactly like the reference hub: the bar turns into a name field.
    showCreateProject(bar) {
        if (bar.classList.contains("is-creating")) return bar.querySelector(".ahr-create-input")?.focus();
        const saved = [...bar.children];
        const form = el("form", "ahr-create-form");
        const input = el("input", "ahr-name ahr-create-input");
        input.placeholder = "新片段项目名称";
        input.maxLength = 80;
        input.setAttribute("aria-label", "新片段项目名称");
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
            try {
                const data = await this.fetchJson("/amiaomiao_h3/clip_bin/project", { method: "POST",
                    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: typed }) });
                input.blur();
                this.switchProject(data.name || typed);
                this.toast(`已新建片段项目「${data.name || typed}」`);
            } catch (err) {
                error.textContent = err.message;
                confirm.disabled = false;
                input.focus();
            }
        });
        const label = el("span", "ahr-project-label");
        label.append(icon("plus"), el("span", "", "新建片段项目"));
        form.append(input, confirm, cancel);
        bar.classList.add("is-creating");
        bar.replaceChildren(label, form, error);
        input.focus();
    }

    // A setting of the node, chosen once for the workflow it sits in: a quiet one-line toggle
    // (the generation settings' text segment), visually below the library it belongs with.
    flowLine() {
        const line = el("div", "ahc-flow");
        const label = el("span", "ahc-flow-label");
        label.append(icon("sitemap"), el("span", "", "工作流"));
        const group = el("div", "ahs-seg");
        group.setAttribute("role", "radiogroup");
        group.setAttribute("aria-label", "工作流");
        for (const [value, tip] of [
            [FLOW_DUAL, "双采样工作流（一采 + 二采放大，如万物皆可接续）：两个接续口都输出，保存一采和二采"],
            [FLOW_SINGLE, "单采样工作流（只采样一次）：只用一采接续，只保存一采"]]) {
            const button = el("button", "", value);
            button.type = "button";
            button.title = tip;
            button.setAttribute("role", "radio");
            button.setAttribute("aria-checked", String(this.passes === value));
            button.addEventListener("click", () => {
                if (this.passes === value) return;
                this.fields.set("passes", value);
                if (this.stageWorkflow) this.switchProject(this.project);
                else this.render();
            });
            group.append(button);
        }
        const note = el("span", "ahc-flow-note", this.passes === FLOW_DUAL ? "一采 + 二采放大的工作流" : "只采样一次的工作流");
        line.append(label, group, note);
        return line;
    }

    contextLine() {
        if (this.fields.get("context_length") == null) return document.createDocumentFragment();
        const { video_frames, audio, audio_frames } = this.context;
        const row = el("fieldset", "ahc-context");
        row.disabled = this.mode !== MODE_CONTINUE;
        const video = el("div", "ahc-context-field");
        const label = el("span", "", "画面重叠");
        label.title = "沿用上一段结尾的画面帧数。Motion Context 接入「接续信息」后使用此设置。";
        const frames = el("div", "ahs-seg");
        frames.setAttribute("role", "group");
        frames.setAttribute("aria-label", "画面重叠");
        for (const value of CONTEXT_LENGTHS) {
            const button = el("button", "", value);
            button.type = "button";
            button.title = `${value} 帧 · ${(Number(value) / 24).toFixed(2)} 秒`;
            button.setAttribute("aria-pressed", String(video_frames === Number(value)));
            button.addEventListener("click", () => {
                this.fields.set("context_length", value);
                for (const item of frames.children) item.setAttribute("aria-pressed", String(item === button));
            });
            frames.append(button);
        }
        video.append(label, frames, el("span", "", "帧"));

        const sound = el("div", "ahc-context-field");
        const toggle = el("label", "ahr-toggle");
        toggle.title = "带入上一段结尾的声音。关闭不影响画面接续。";
        const check = el("input");
        check.type = "checkbox";
        check.checked = audio;
        toggle.append(check, el("span", "ahr-switch"), el("span", "", "声音接续"));
        const length = el("input", "ahr-number");
        Object.assign(length, { type: "number", min: 0, max: AUDIO_LENGTH_MAX, step: 1, value: audio_frames, disabled: !audio });
        length.setAttribute("aria-label", "声音接续帧数");
        length.title = "按视频帧计。填 0 时与画面重叠帧数相同。";
        check.addEventListener("change", () => {
            this.fields.set("enable_audio_context", check.checked);
            length.disabled = !check.checked;
        });
        length.addEventListener("change", () => {
            const value = normalizeContext(undefined, undefined, length.value).audio_frames;
            length.value = String(value);
            this.fields.set("audio_context_length", value);
        });
        sound.append(toggle, length, el("span", "", "帧"));
        row.append(el("legend", "", "接续设置"), video, sound);
        return row;
    }

    // This run: the mode decides whether the clip grid matters at all, so they sit together.
    runSection() {
        const section = el("section", "ahr-section is-video ahc-run");
        const head = el("div", "ahr-section-head");
        const name = el("h3", "ahr-section-title");
        name.append(el("span", "ahr-kind-dot"), el("span", "", "本次运行"));
        head.append(name);
        section.append(head);
        if (!this.refineId) section.append(poolChooser("模式", [
            [MODE_CONTINUE, "接续前段", "接着下面选中的片段生成", "link", "接着选中的片段（默认最新）往下生成；库是空的时自动按全新段落"],
            [MODE_NEW, "全新段落", "不接任何片段，从头生成", "plus-circle", "不接任何片段，从头生成"],
        ], this.mode, value => this.set("mode", value), "is-mode"));
        if (this.dualStage && !this.refineId) section.append(this.stageLine());
        if (!this.refineId) section.append(this.contextLine());
        section.append(this.planLine(), this.clipGrid());
        return section;
    }

    stageLine() {
        const line = el("div", "ahc-flow ahc-stage-line");
        const group = el("div", "ahs-seg");
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", "采样阶段");
        for (const [label, draft] of [["一采＋二采", false], ["只跑一采", true]]) {
            const button = textButton(label, "", () => this.set("draft_only", draft));
            button.className = "";
            button.setAttribute("aria-pressed", String(Boolean(this.fields.get("draft_only")) === draft));
            group.append(button);
        }
        line.append(el("span", "ahc-flow-label", "采样阶段"), group);
        return line;
    }

    planLine() {
        const selected = this.cards.find(c => c.clip_id === this.refineId && c.stage_revision === this.fields.get("refine_revision"));
        const plan = this.loading ? { text: "读取片段…", tone: "continue" }
            : this.refineId ? selected ? { text: `仅跑二采 · ${shotLabel(selected)}`, tone: "continue" }
                : { text: "选中的卡片已变更，请重新选卡", tone: "error" }
            : plannedStatus({ project: this.project, mode: this.mode, passes: this.passes, clips: this.clips, selection: this.selection });
        const line = el("div", `ahc-plan is-${plan.tone}`);
        line.setAttribute("role", "status");
        const glyph = { new: "plus-circle", continue: "link", warn: "exclamation-triangle", error: "times-circle" }[plan.tone];
        const head = el("div", "ahc-plan-main");
        if (!this.refineId && this.dualStage && this.fields.get("draft_only") && plan.tone !== "error" && !this.loading) {
            plan.text = `${plan.text} · 只跑一采，保存为草稿`;
        }
        head.append(icon(glyph || "link"), el("span", "ahc-plan-label", "下次运行"), el("span", "", plan.text));
        if (this.refineId) {
            const cancel = textButton("取消", "", () => { this.clearRefine(); this.render(); }, "is-quiet ahc-stage-cancel");
            head.append(cancel);
        }
        line.append(head);
        if (selected) {
            const parent = this.clips.find(c => c.clip_id === selected.parent_clip_id);
            const size = parent && resolutionOf(parent);
            if (parent) line.append(el("div", "ahc-plan-note", `接自 ${shotLabel(parent)}${size ? ` · 二采需 ${size}` : ""}`));
            else if (selected.parent_clip_id && selected.parent_clip_id !== "[INITIAL]")
                line.append(el("div", "ahc-plan-note", "找不到原接续片段"));
        }
        const newest = this.clips[0];
        const pinned = !this.refineId && !this.loading && this.mode === MODE_CONTINUE && !isLatest(this.selection) ? this.target() : null;
        if (pinned && newest && pinned !== newest) {
            line.classList.add("is-pinned-old");
            line.append(el("div", "ahc-plan-note", `已固定 ${shotLabel(pinned)}，不是最新的 ${shotLabel(newest)}，会从这里分出新的一支`));
        }
        if (plan.missing) {
            const fix = textButton("改回跟随最新", "history", () => { this.setFollow(true); this.toast("已改回跟随最新"); }, "is-confirm ahc-plan-fix");
            line.append(fix);
        }
        if (this.lastRun?.status && !this.loading) line.append(el("div", "ahc-plan-last", `上次运行：${this.lastRun.status}`));
        return line;
    }

    visibleClips() {
        if (this.draftPage) return this.drafts;
        if (this.view !== "chain") return this.clips;
        const chain = chainOf(this.clips, this.target());
        return chain;
    }

    clipGrid() {
        const wrap = el("div", "ahc-clips");
        if (this.dualStage) {
            const tabs = el("div", "ahr-tabs ahc-stage-tabs");
            tabs.setAttribute("role", "group");
            tabs.setAttribute("aria-label", "片段库");
            for (const [page, label] of [["draft", "一采草稿"], ["complete", "二采成片"]]) {
                const tab = textButton(label, "", () => this.openPage(page), "ahc-stage-tab");
                tab.setAttribute("aria-pressed", String(this.page === page));
                tabs.append(tab);
            }
            wrap.append(tabs);
        }
        const head = el("div", "ahc-clips-head");
        if (!this.draftPage && !this.refineId) head.append(this.followSwitch());
        const visible = this.visibleClips();
        const title = el("span", "ahc-clips-title", this.mode === MODE_NEW ? "接续片段（全新段落时不使用）" : "接续片段");
        title.append(el("span", "ahr-zone-count", this.loading ? ""
            : this.view === "chain" ? `${visible.length} / ${this.clips.length} 个` : `${this.clips.length} 个`));
        if (!this.draftPage && !this.dualStage) head.append(title);
        const tools = el("div", "ahc-clips-tools");
        const view = el("div", "ahs-seg");
        view.setAttribute("role", "radiogroup");
        view.setAttribute("aria-label", "显示");
        for (const [value, label, tip] of [["all", "全部", "显示项目里的全部片段"],
            ["chain", "接续链", "只显示下次运行要接的这一支：所选片段、它接自的片段……一直往前"]]) {
            const option = el("button", "", label);
            option.type = "button";
            option.title = tip;
            option.setAttribute("role", "radio");
            option.setAttribute("aria-checked", String(this.view === value));
            option.disabled = value === "chain" && !this.target();
            option.addEventListener("click", () => { if (this.view !== value) { this.view = value; this.render(); } });
            view.append(option);
        }
        const batch = textButton(this.batch ? "完成" : "批量", this.batch ? "check" : "check-square",
            () => { this.batch = !this.batch; this.marked.clear(); this.render(); }, this.batch ? "is-confirm" : "is-quiet");
        batch.title = this.batch ? "退出批量选择" : "批量锁定、解锁或删除片段";
        batch.setAttribute("aria-pressed", String(this.batch));
        batch.disabled = !visible.length;
        if (!this.draftPage) tools.append(view);
        tools.append(batch);
        head.append(tools);
        wrap.append(head);
        if (this.batch) wrap.append(this.batchBar(visible));
        const grid = el("div", `ahc-grid${this.draftPage ? " is-drafts" : this.mode === MODE_NEW ? " is-idle" : ""}`);
        grid.setAttribute("role", "listbox");
        grid.setAttribute("aria-label", this.draftPage ? "一采草稿" : this.dualStage ? "二采成片" : "接续片段");
        if (this.error) {
            grid.append(this.empty("exclamation-triangle", `读取失败：${this.error}`, true));
        } else {
            for (const clip of visible) grid.append(this.card(clip));
            if (!this.loading && this.draftPage && !visible.length) grid.append(this.empty("inbox", "暂无一采草稿"));
            else if (!this.loading && !this.clips.length && !this.draftPage)
                grid.append(this.empty("inbox", this.dualStage ? "暂无二采成片" : "这个项目还没有片段"));
            else if (!this.loading && !visible.length) grid.append(this.empty("share-alt", "没有可显示的接续链"));
        }
        wrap.append(grid);
        return wrap;
    }

    batchBar(visible) {
        const bar = el("div", "ahr-zone-head ahc-batch");
        const all = el("label", "ahc-batch-all");
        const box = el("input");
        box.type = "checkbox";
        const ids = visible.map(c => c.clip_id);
        const markedVisible = ids.filter(id => this.marked.has(id));
        box.checked = ids.length > 0 && markedVisible.length === ids.length;
        box.indeterminate = markedVisible.length > 0 && !box.checked;
        box.setAttribute("aria-label", "全选");
        box.addEventListener("change", () => {
            if (box.checked) ids.forEach(id => this.marked.add(id)); else ids.forEach(id => this.marked.delete(id));
            this.render();
        });
        all.append(box, el("span", "", "全选"));
        const chosen = this.cards.filter(c => this.marked.has(c.clip_id));
        const unlocked = chosen.filter(c => !c.locked);
        bar.append(all, el("span", "ahr-zone-count", `已选 ${chosen.length} 个`));
        const lock = textButton("锁定", "lock", () => this.setLocks(chosen, true), "ahr-zone-action");
        lock.disabled = !chosen.some(c => !c.locked);
        const unlock = textButton("解锁", "unlock", () => this.setLocks(chosen, false), "ahr-zone-action");
        unlock.disabled = !chosen.some(c => c.locked);
        const remove = textButton(`删除 ${unlocked.length} 个`, "trash", () => {
            const confirm = el("div", "ahr-clear-confirm");
            confirm.setAttribute("role", "group");
            confirm.setAttribute("aria-label", "确认批量删除");
            const skipped = chosen.length - unlocked.length;
            const yes = textButton(`删除 ${unlocked.length} 个`, "trash", () => this.deleteMany(unlocked), "is-danger-solid");
            const no = textButton("取消", "", () => confirm.replaceWith(remove));
            confirm.append(el("span", "ahr-clear-text", skipped ? `删除？已锁定的 ${skipped} 个会保留` : "删除？"), yes, no);
            confirm.addEventListener("keydown", event => {
                if (event.key === "Escape") { event.stopPropagation(); confirm.replaceWith(remove); remove.focus(); }
            });
            remove.replaceWith(confirm);
            no.focus();
        }, "ahr-zone-action ahc-batch-delete");
        remove.disabled = !unlocked.length;
        if (chosen.length && !unlocked.length) remove.title = "选中的片段都已锁定";
        bar.append(lock, unlock, remove);
        return bar;
    }

    async setLocks(clips, locked) {
        const targets = clips.filter(c => !!c.locked !== locked);
        if (!targets.length) return;
        try {
            await this.fetchJson("/amiaomiao_h3/clip_bin/lock", { method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ project: this.project, clip_ids: targets.map(c => c.clip_id), locked }) });
            for (const clip of targets) clip.locked = locked;
            this.render();
            this.toast(`${targets.length} 个片段已${locked ? "锁定" : "解锁"}`);
        } catch (error) {
            this.toast(`${locked ? "锁定" : "解锁"}失败：${error.message}`, true);
        }
    }

    async deleteMany(clips) {
        try {
            const result = await this.fetchJson("/amiaomiao_h3/clip_bin/delete_many", { method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ project: this.project, clip_ids: clips.map(c => c.clip_id) }) });
            const deleted = result.deleted || [];
            if (deleted.includes(this.selection)) this.fields.set("clip_selection", LATEST);
            for (const id of deleted) this.marked.delete(id);
            const kept = (result.locked || []).length;
            this.toast(`已删除 ${deleted.length} 个片段${kept ? `，${kept} 个已锁定的保留` : ""}`);
            await this.reload({ projects: true });
        } catch (error) {
            this.toast(`删除失败：${error.message}`, true);
        }
    }

    // 4: rename in place. Click the name to edit; Enter / blur saves, Esc cancels.
    nameEditor(clip) {
        const name = el("button", "ahc-name ahc-name-edit", shotLabel(clip));
        name.type = "button";
        name.title = "点击改名";
        name.setAttribute("aria-label", `改名：${shotLabel(clip)}`);
        name.addEventListener("click", event => {
            event.stopPropagation();
            const input = el("input", "ahr-name ahc-name-input");
            input.value = shotLabel(clip);
            input.maxLength = 60;
            input.setAttribute("aria-label", "镜头名");
            let done = false;
            const finish = async save => {
                if (done) return;
                done = true;
                const next = input.value.trim();
                if (!save || !next || next === shotLabel(clip)) { input.replaceWith(name); return; }
                try {
                    const data = await this.fetchJson("/amiaomiao_h3/clip_bin/rename", { method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ project: this.project, clip_id: clip.clip_id, shot_tag: next }) });
                    clip.shot_tag = data.shot_tag || next;
                    input.blur();
                    this.render();
                    this.toast(`已改名为「${clip.shot_tag}」`);
                } catch (error) {
                    input.replaceWith(name);
                    this.toast(`改名失败：${error.message}`, true);
                }
            };
            input.addEventListener("keydown", e => {
                e.stopPropagation();
                if (e.key === "Enter") { e.preventDefault(); finish(true); }
                if (e.key === "Escape") { e.preventDefault(); finish(false); }
            });
            input.addEventListener("blur", () => finish(true));
            for (const type of ["click", "dblclick", "pointerdown"]) input.addEventListener(type, e => e.stopPropagation());
            name.replaceWith(input);
            input.focus();
            input.select();
        });
        return name;
    }

    empty(glyph, text, error = false) {
        const box = el("div", `ahr-add-tile ahc-empty${error ? " is-error" : ""}`);
        box.append(icon(glyph), el("span", "ahr-add-label", text));
        return box;
    }

    // ---------- cards ----------
    chosenBadge(auto = false) {
        const badge = el("span", `ahr-badge is-video ahc-chosen${auto ? " is-auto" : ""}`);
        badge.append(icon(auto ? "history" : "map-marker"), el("span", "", auto ? "接续这一段 · 自动" : "接续这一段 · 已固定"));
        return badge;
    }

    // "跟随最新" sits top-left of the clip wall and says what it means in words: on = the next
    // run takes whatever is newest (named), off = one clip is pinned (named). Clicking a card pins it.
    followSwitch() {
        const follow = isLatest(this.selection);
        const newest = this.clips[0];
        const pinned = follow ? null : this.clips.find(c => c.clip_id === this.selection);
        const box = el("label", `ahr-toggle ahc-follow${follow ? " is-on" : ""}`);
        box.title = follow ? "开着：每次运行都接最新的片段，存了新片段会自动换。点任意卡片可固定接那一段。"
            : "关着：固定接选中的那一段。打开则改回每次接最新。";
        const input = el("input");
        input.type = "checkbox";
        input.checked = follow;
        input.setAttribute("aria-label", "跟随最新");
        input.addEventListener("change", () => this.setFollow(input.checked));
        const text = el("span", "ahc-follow-text");
        text.append(el("strong", "", "跟随最新"));
        let detail;
        if (follow) detail = newest ? `自动接最新：${shotLabel(newest)}` : "库里还没有片段";
        else detail = pinned ? `已固定：${shotLabel(pinned)}` : "已固定的片段不在了";
        text.append(el("small", "", detail));
        box.append(input, el("span", "ahr-switch"), text);
        return box;
    }

    videoUrl(clip, variant) {
        const file = clip.variants?.[variant]?.video_file;
        if (file && clip.subfolder) {
            const query = new URLSearchParams({ filename: file, subfolder: clip.subfolder, type: "output" });
            if (clip.stage_revision) query.set("v", clip.stage_revision);
            return this.url(`/view?${query}`);
        }
        return clip.video_url ? this.url(clip.video_url) : "";
    }

    bestVideo(clip) {
        for (const variant of [PASS_TWO, PASS_ONE]) {
            if (clip.variants?.[variant]?.has_video) return this.videoUrl(clip, variant);
        }
        return clip.has_video ? this.url(clip.video_url) : "";
    }

    card(clip) {
        const draft = clip.clip_stage === "draft";
        const refining = clip.clip_id === this.refineId && clip.stage_revision === this.fields.get("refine_revision");
        const newest = clip === this.clips[0];
        const continuing = !draft && !this.refineId && this.mode === MODE_CONTINUE;
        const auto = continuing && isLatest(this.selection) && newest;
        const on = refining || auto || (continuing && this.selection === clip.clip_id);
        const card = el("div", `ahr-card ahc-card${on ? " is-selected" : ""}${auto ? " is-auto" : ""}${clip.locked ? " is-locked" : ""}`);
        card.setAttribute("role", "option");
        card.setAttribute("aria-selected", String(on));
        card.tabIndex = 0;
        card.dataset.clipId = clip.clip_id;
        card.title = draft || this.refineId ? "双击查看详情" : "单击接续这一段，双击查看详情";
        const cover = el("div", "ahc-cover");
        if (clip.thumbnail_url) {
            const image = el("img");
            image.src = this.url(clip.thumbnail_url + (clip.stage_revision ? `&v=${encodeURIComponent(clip.stage_revision)}` : ""));
            image.alt = "";
            image.loading = "lazy";
            image.draggable = false;
            image.addEventListener("error", () => image.replaceWith(icon("image")));
            cover.append(image);
        } else {
            cover.append(icon("image"));
        }
        if (this.bestVideo(clip)) {
            const play = el("button", "ahr-cover-play");
            play.type = "button";
            play.title = "播放";
            play.setAttribute("aria-label", "播放");
            play.append(icon("play"));
            play.addEventListener("click", event => { event.stopPropagation(); this.openDetail(clip); });
            cover.append(play);
            this.hoverPreview(card, cover, clip);
        }
        if (draft) cover.append(el("span", "ahr-badge is-video ahc-draft-badge", "一采草稿"));
        else if (on && !refining) cover.append(this.chosenBadge(auto));
        if (newest) cover.append(el("span", "ahc-newest", "最新"));
        // always-visible card tools, as on the reference hub cards
        const tools = el("div", "ahr-card-tools");
        const lock = textButton(clip.locked ? "已锁定" : "锁定", clip.locked ? "lock" : "lock-open",
            () => this.setLock(clip, !clip.locked), clip.locked ? "is-locked" : "");
        lock.title = clip.locked ? "已锁定，点击解锁" : "锁定，防止误删";
        lock.setAttribute("aria-label", lock.title);
        lock.setAttribute("aria-pressed", String(!!clip.locked));
        tools.append(lock, this.deleteButton(clip));
        if (this.dualStage && !draft && clip.stage_ready && !this.batch) {
            const more = iconButton("ellipsis-h", "更多片段操作", () => {
                const visible = menu.hidden;
                menu.hidden = !visible;
                confirm.hidden = true;
                more.setAttribute("aria-expanded", String(visible));
                if (visible) menu.querySelector("button")?.focus();
            });
            more.setAttribute("aria-expanded", "false");
            const menu = el("div", "ahc-rerun-menu");
            menu.hidden = true;
            const confirm = el("div", "ahc-rerun-confirm");
            confirm.hidden = true;
            const rerun = textButton("重跑二采", "refresh", () => {
                menu.hidden = true;
                confirm.hidden = false;
                confirm.querySelector("button")?.focus();
            });
            rerun.disabled = Boolean(clip.locked);
            if (clip.locked) rerun.title = "请先解锁这张成片";
            menu.append(rerun);
            const cancel = () => {
                menu.hidden = true;
                confirm.hidden = true;
                more.setAttribute("aria-expanded", "false");
                more.focus();
            };
            confirm.append(el("p", "", "二采成功后将替换当前二采结果，一采不变。"),
                textButton("取消", "", cancel, "is-quiet"),
                textButton("确认重跑", "check", () => this.chooseRefine(clip), "is-danger"));
            tools.append(more);
            card.append(menu, confirm);
            card.addEventListener("keydown", event => {
                if (event.key === "Escape" && (!menu.hidden || !confirm.hidden)) {
                    event.stopPropagation();
                    cancel();
                }
            });
        }
        cover.append(tools);

        const body = el("div", "ahc-body");
        const nameRow = el("div", "ahc-name-row");
        nameRow.append(this.nameEditor(clip));
        const when = relativeTime(clip.created_at);
        if (when) {
            const time = el("span", "ahc-time", when);
            time.title = fullTime(clip.created_at);
            nameRow.append(time);
        }
        body.append(nameRow);
        const passes = el("div", "ahc-passes");
        const have = variantsOf(clip);
        for (const name of [PASS_ONE, PASS_TWO]) {
            if (have[name] === undefined) continue;
            const pill = el("span", `ahc-pass${name === PASS_TWO ? " is-two" : ""}`);
            pill.append(el("b", "", name), el("span", "", have[name] ? `${have[name].toFixed(1)}s` : "—"));
            passes.append(pill);
        }
        body.append(passes);
        const meta = el("div", "ahr-meta ahc-meta");
        const parent = parentLabel(clip, this.clips);
        meta.append(el("span", "", parent ? `接自 ${parent}` : "全新段落"), el("span", "", resolutionOf(clip)));
        body.append(meta);
        if (refining || (draft && clip.stage_ready && !this.batch)) {
            const actions = el("div", "ahc-draft-actions");
            if (refining) {
                const selected = el("span", "ahc-draft-selected");
                selected.append(icon("check"), el("span", "", "已选作二采"));
                actions.append(selected);
            } else {
                actions.append(textButton("用这张做二采", "arrow-right", () => this.chooseRefine(clip), "is-confirm"));
            }
            body.append(actions);
        }
        card.append(cover, body);
        if (this.batch) {
            const mark = el("input", "ahc-mark");
            mark.type = "checkbox";
            mark.checked = this.marked.has(clip.clip_id);
            mark.setAttribute("aria-label", `选择 ${shotLabel(clip)}`);
            mark.addEventListener("click", e => e.stopPropagation());
            mark.addEventListener("change", () => {
                if (mark.checked) this.marked.add(clip.clip_id); else this.marked.delete(clip.clip_id);
                this.render();
            });
            cover.append(mark);
            card.classList.toggle("is-marked", mark.checked);
        }
        card.addEventListener("click", event => {
            if (event.detail > 1 || event.target.closest("button, input, .ahr-clear-confirm")) return;
            if (this.batch) {
                if (this.marked.has(clip.clip_id)) this.marked.delete(clip.clip_id); else this.marked.add(clip.clip_id);
                this.render();
                return;
            }
            if (draft || this.refineId) return;
            this.beforeClick = { at: Date.now(), mode: this.fields.get("mode"), selection: this.selection };
            this.pick(clip);
        });
        card.addEventListener("keydown", event => {
            if (event.target !== card) return;
            if (event.key === "Enter") { event.preventDefault(); this.openDetail(clip); }
            if (event.key === " ") {
                event.preventDefault();
                if (this.batch) {
                    if (this.marked.has(clip.clip_id)) this.marked.delete(clip.clip_id);
                    else this.marked.add(clip.clip_id);
                    this.render();
                } else if (!draft && !this.refineId) this.pick(clip);
            }
        });
        return card;
    }

    hoverPreview(card, cover, clip) {
        const src = this.bestVideo(clip);
        let video = null, timer = null;
        const stop = () => {
            clearTimeout(timer);
            if (video) { video.pause(); video.removeAttribute("src"); video.load(); video.remove(); video = null; }
        };
        card.addEventListener("mouseenter", () => {
            timer = setTimeout(() => {
                if (!card.isConnected) return;
                video = el("video", "ahc-hover");
                Object.assign(video, { src, muted: true, loop: true, playsInline: true, autoplay: true });
                cover.insertBefore(video, cover.querySelector(".ahr-cover-play"));
            }, 220);
        });
        card.addEventListener("mouseleave", stop);
    }

    // Delete with the hub's inline confirm (no browser dialog); locked cards cannot be deleted.
    deleteButton(clip) {
        const button = iconButton("trash", clip.locked ? "已锁定，先解锁才能删除" : "删除这个片段", () => {
            const confirm = el("div", "ahr-clear-confirm");
            confirm.setAttribute("role", "group");
            confirm.setAttribute("aria-label", "确认删除片段");
            const yes = textButton("删除", "trash", async () => {
                yes.disabled = true;
                try {
                    await this.fetchJson("/amiaomiao_h3/clip_bin/delete", { method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ project: this.project, clip_id: clip.clip_id }) });
                    if (this.selection === clip.clip_id) this.fields.set("clip_selection", LATEST);
                    this.toast(`已删除 ${shotLabel(clip)}`);
                    await this.reload({ projects: true });
                } catch (error) {
                    this.toast(`删除失败：${error.message}`, true);
                    confirm.replaceWith(button);
                }
            }, "is-danger-solid");
            const no = textButton("取消", "", () => confirm.replaceWith(button));
            confirm.append(el("span", "ahr-clear-text", "删除？"), yes, no);
            confirm.addEventListener("keydown", event => {
                if (event.key === "Escape") { event.stopPropagation(); confirm.replaceWith(button); button.focus(); }
            });
            button.replaceWith(confirm);
            no.focus();
        }, "is-danger");
        button.disabled = !!clip.locked;
        return button;
    }

    async setLock(clip, locked) {
        try {
            await this.fetchJson("/amiaomiao_h3/clip_bin/lock", { method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ project: this.project, clip_ids: [clip.clip_id], locked }) });
            clip.locked = locked;
            this.render();
            this.toast(`${shotLabel(clip)} 已${locked ? "锁定" : "解锁"}`);
        } catch (error) {
            this.toast(`锁定失败：${error.message}`, true);
        }
    }

    openLibrary() {
        openLibraryBrowser({
            scope: "clips", current: this.project, url: this.url, clipAssetKind: this.assetKind,
            fetchJson: (path, options) => this.fetchJson(path, options),
            onUse: name => { this.switchProject(name); this.toast(`已切换到「${name}」`); },
            onPickClip: (name, clip) => {
                if (clip.clip_stage === "draft") {
                    this.switchProject(name);
                    this.openPage("draft");
                    this.chooseRefine(clip);
                } else {
                    this.switchProject(name, clip.clip_id);
                    this.toast(`接续 ${shotLabel(clip)}`);
                }
            },
            onRenamed: (from, to) => { this.projects = null; if (this.project === from) this.switchProject(to); else this.render(); },
            onDeleted: (name, next) => { this.projects = null; if (next) this.switchProject(next); else this.render(); },
        });
    }

    switchProject(name, selection = LATEST) {
        this.batch = false;
        this.marked.clear();
        this.fields.set("project_name", name);
        this.fields.set("clip_selection", selection);
        this.clearRefine();
        this.page = "complete";
        this.openedDraftOnSave = false;
        this.projects = null;
        this.loading = true;
        this.clips = [];
        this.drafts = [];
        this.render();
        this.reload();
    }

    // ---------- detail (library-browser dialog shell) ----------
    openDetail(clip) {
        document.querySelector(".ahc-modal")?._close?.();
        const overlay = el("div", "ahl-overlay ahc-modal is-open");
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", shotLabel(clip));
        const dialog = el("div", "ahl-dialog ahc-dialog");
        const head = el("header", "ahl-head");
        const badge = el("span", "ahl-head-icon");
        badge.append(icon("video"));
        const close = el("button", "ahl-icon-btn ahl-close");
        close.type = "button";
        close.title = "关闭";
        close.setAttribute("aria-label", "关闭");
        close.append(icon("times"));
        head.append(badge, el("h2", "ahl-title", shotLabel(clip)), el("span", "ahl-count", this.project), close);
        const body = el("div", "ahc-detail");
        const stage = el("div", "ahc-stage");
        const have = variantsOf(clip);
        const available = [PASS_TWO, PASS_ONE].filter(v => clip.variants?.[v]?.has_video);
        const player = el("video", "ahc-player");
        player.controls = true;
        player.playsInline = true;
        const show = variant => {
            const src = variant ? this.videoUrl(clip, variant) : this.bestVideo(clip);
            if (src) { player.src = src; player.play().catch(() => {}); }
        };
        if (available.length > 1) {
            const seg = el("div", "ahl-seg");
            seg.setAttribute("role", "group");
            seg.setAttribute("aria-label", "视频");
            for (const variant of available) {
                const option = el("button", "ahl-seg-btn", variant);
                option.type = "button";
                option.setAttribute("aria-pressed", String(variant === available[0]));
                option.addEventListener("click", () => {
                    for (const b of seg.children) b.setAttribute("aria-pressed", String(b === option));
                    show(variant);
                });
                seg.append(option);
            }
            stage.append(seg);
        }
        if (this.bestVideo(clip)) { stage.append(player); show(available[0]); }
        else {
            const still = el("div", "ahc-still");
            if (clip.thumbnail_url) { const img = el("img"); img.src = this.url(clip.thumbnail_url); img.alt = ""; still.append(img); }
            else still.append(icon("image"));
            stage.append(still);
        }
        const info = el("aside", "ahc-info");
        const facts = el("dl", "ahl-facts");
        const fact = (label, value) => {
            const row = el("div", "ahl-fact");
            row.append(el("dt", "", label), el("dd", "", value));
            facts.append(row);
        };
        for (const name of [PASS_ONE, PASS_TWO]) {
            if (have[name] === undefined) continue;
            const v = clip.variants?.[name] || clip;
            fact(name, [have[name] ? `${have[name].toFixed(2)} 秒` : "", v.frames ? `${v.frames} 帧` : ""].filter(Boolean).join(" · ") || "—");
        }
        const res = resolutionOf(clip);
        if (res) fact("分辨率", res);
        fact("接自", parentLabel(clip, this.clips) || "全新段落");
        fact("生成时间", fullTime(clip.created_at) || "—");
        fact("片段 ID", clip.clip_id);
        info.append(facts);
        const promptBox = el("section", "ahl-contents ahc-prompt");
        const promptHead = el("div", "ahl-section-head");
        promptHead.append(el("span", "", "提示词"));
        promptBox.append(promptHead, el("pre", clip.prompt ? "" : "is-empty", clip.prompt || "保存时没有接提示词"));
        info.append(promptBox);
        const actions = el("div", "ahl-actions");
        const use = el("button", "ahl-btn is-primary");
        use.type = "button";
        const current = this.target() === clip;
        const draft = clip.clip_stage === "draft";
        const label = draft ? "用这张做二采" :
            !current ? "接续这一段" : isLatest(this.selection) ? "正在接续（跟随最新）" : "正在接续（已固定）";
        use.append(icon(current ? "check" : "link"), el("span", "", label));
        use.disabled = draft ? !clip.stage_ready || this.refineId === clip.clip_id : current || Boolean(this.refineId);
        use.addEventListener("click", () => { if (draft) this.chooseRefine(clip); else this.pick(clip); done(); });
        actions.append(use);
        info.append(actions);
        body.append(stage, info);
        dialog.append(head, body);
        overlay.append(dialog);
        const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); done(); } };
        const done = () => {
            player.pause(); player.removeAttribute("src"); player.load();
            document.removeEventListener("keydown", onKey, true);
            overlay.remove();
        };
        overlay._close = done;
        close.addEventListener("click", done);
        overlay.addEventListener("pointerdown", event => { overlay._down = event.target === overlay; });
        overlay.addEventListener("click", event => { if (event.target === overlay && overlay._down) done(); });
        for (const type of ["pointerdown", "mousedown", "wheel", "dblclick"]) overlay.addEventListener(type, e => e.stopPropagation());
        document.addEventListener("keydown", onKey, true);
        document.body.append(overlay);
        use.focus();
    }
}

export class ClipSaverPanel {
    constructor() {
        this.root = el("div", "ahr ahc ahc-saver");
        this.result = null;
        this.render();
    }

    showResult(message) {
        this.result = message?.h3_clip_v2?.[0] || null;
        this.render();
    }

    render() {
        this.root.replaceChildren();
        const line = el("div", `ahc-plan is-${this.result ? "continue" : "idle"}`);
        line.setAttribute("role", "status");
        const head = el("div", "ahc-plan-main");
        head.append(icon(this.result ? "check-circle" : "save"),
            el("span", "ahc-plan-label", this.result ? "已保存" : "保存到"),
            el("span", "", this.result ? this.result.status.replace(/^已存为 /, "") : "片段选择里的项目"));
        line.append(head);
        if (this.result?.project) line.append(el("div", "ahc-plan-last", `片段项目库：${this.result.project}`));
        this.root.append(line);
    }
}
