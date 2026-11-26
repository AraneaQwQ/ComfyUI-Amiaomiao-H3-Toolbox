import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { addPanel } from "./dom_panel.js";
import { adjacentSelection, toggleMergeSelection } from "./deck_selection.js";
import { moveCard, parseOrder, resolveDeckOrder } from "../clipstream/long_builder_order.js";
import { button, createFields, createPreview, createProjectBar, createShell, el, fetchJson,
    icon, mediaUrl, outputUrl, post, section } from "./video_v3_ui.js";

const CUT = "AmiaomiaoH3_H3VideoCutterV3";
const BUILD = "AmiaomiaoH3_H3LongBuilderV3";
const LVM = "/amiaomiao_h3/lvm";
const CLIPS = "/amiaomiao_h3/clip_bin";
const SPEED = [["1.0x", "1.0× 原速"], ["0.75x", "0.75×"], ["0.5x", "0.5×"], ["custom", "自定义"]];

function stylesheet(id, file) {
    if (document.getElementById(id)) return;
    const link = el("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = new URL(file, import.meta.url).href;
    document.head.append(link);
}

function mediaCard(name, badge, imageUrl, facts) {
    const card = el("article", "ahr-card ahv3-card");
    const cover = el("div", "ahc-cover ahv3-cover");
    const placeholder = icon("video");
    cover.append(placeholder);
    if (imageUrl) {
        const image = el("img");
        image.alt = "";
        image.draggable = false;
        image.loading = "lazy";
        image.src = mediaUrl(imageUrl);
        image.addEventListener("error", () => image.remove(), { once: true });
        cover.append(image);
    }
    cover.append(el("span", "ahr-badge is-video", badge));
    const title = el("strong", "ahv3-card-name", name);
    const tools = el("div", "ahr-card-tools is-inline ahv3-card-actions"), body = el("div", "ahv3-card-body");
    title.title = name;
    body.append(title, el("div", "ahv3-facts", facts), tools);
    card.append(cover, body);
    return { card, cover, tools };
}

function install(node, cut) {
    stylesheet("amiaomiao-ahv3-base", "../refs/refs.css");
    stylesheet("amiaomiao-ahv3", "./video_v3.css");
    stylesheet("amiaomiao-ahv3-theme", "../refs/ui_theme.css");
    const lifetime = new AbortController();
    const { signal } = lifetime;
    const fields = createFields(node, signal);
    const { read, write, field } = fields;
    for (const widget of node.widgets || []) {
        widget.options ??= {};
        widget.options.hidden = true;
    }
    const { root, body, toast, refreshDensity } = createShell(node,
        cut ? "视频裁切 V3" : "长视频拼接 V3", cut ? "sliders-h" : "video", signal);
    const preview = createPreview(signal);
    const clipKind = () => read("asset_kind") || "dual";
    const num = (min, max, step) => ({ numeric: { min, max, step, required: true } });
    const safe = action => async event => {
        const control = event.currentTarget;
        control.disabled = true;
        try { await action(); } catch (error) { toast(error.message, true); }
        finally { control.disabled = false; }
    };
    let visualMode = () => {};
    if (cut) {
        root.classList.add("ahv3-cutter");
        body.tabIndex = 0;
        body.setAttribute("role", "region");
        body.setAttribute("aria-label", "视频裁切设置与片段");
        const source = section(body, "源视频", "video");
        source.content.classList.add("ahv3-source-fields");
        const files = fields.widget("video")?.options?.values;
        if (Array.isArray(files)) field(source.content, "video", "input 视频", { options: files, fullValue: true });
        else field(source.content, "video", "input 视频", { wrap: true, placeholder: "input 下的相对路径" });
        field(source.content, "custom_path", "本地完整路径", { wrap: true, placeholder: "选填，优先于 input 视频" });
        source.actions.append(
            button("选择视频", "folder-open", safe(async () => {
                const data = await post(`${LVM}/system_video_picker`, {}, signal);
                if (!data.cancelled && data.path && !signal.aborted) {
                    preview.close();
                    write("custom_path", data.path);
                    fields.refresh();
                }
            })),
            button("预览源视频", "play", safe(async () => {
                const result = await post(`${LVM}/source_preview`, {
                    video: read("video") || "", custom_path: read("custom_path") || "",
                }, signal);
                preview.open(result.name || "源视频", result.proxy_recommended ? "" : result.url, result.proxy_url);
            }), true),
        );
        const split = section(body, "裁切方式", "sliders-h");
        const choices = el("div", "ahr-pool ahv3-mode");
        choices.setAttribute("role", "group");
        choices.setAttribute("aria-label", "裁切方式");
        const fixed = () => read("split_mode") !== "smart";
        for (const [value, label, mark] of [["fixed", "定长裁切", "clock"], ["smart", "智能分镜", "bolt"]]) {
            const control = button(label, mark, () => {
                write("split_mode", value);
                visualMode();
                fields.refresh();
            });
            control.className = "ahr-pool-option";
            control.dataset.mode = value;
            choices.append(control);
        }
        split.content.append(choices);
        field(split.content, "segment_duration", "每段时长（秒）", { ...num(0.5, 120, 0.001), show: fixed });
        field(split.content, "detection_sensitivity", "切点灵敏度", {
            options: [["low", "低"], ["medium", "中"], ["high", "高"]], show: () => !fixed(),
        });
        const overlap = field(split.content, "motion_context_frames", "接续重叠", {
            options: [["auto", "按裁切模式默认"], ["0", "0 帧"], ["5", "5 帧"], ["22", "22 帧"], ["39", "39 帧"], ["56", "56 帧"]],
        });
        overlap.parentElement.classList.add("ahv3-overlap");
        visualMode = () => {
            for (const control of choices.children) {
                control.setAttribute("aria-pressed", String((control.dataset.mode === "fixed") === fixed()));
            }
            overlap.options[0].textContent = `按裁切模式默认（${fixed() ? 22 : 0} 帧）`;
        };
        field(split.content, "scale_percent", "画面缩放（%）", num(10, 100, 1));
        field(split.content, "playback_speed", "切片慢放", { options: SPEED });
        field(split.content, "playback_speed_custom", "自定义慢放", { ...num(0.1, 1, 0.1),
            show: () => read("playback_speed") === "custom" });
        field(split.content, "align_to_h3_grid", "对齐 H3 帧数", { toggle: true, show: fixed });
    } else {
        const settings = section(body, "拼接设置", "sliders-h");
        field(settings.content, "asset_kind", "片段来源", { options: [["dual", "双采片段"], ["single", "单采片段"]], change: () => {
            resetOrder();
            void project.refresh();
            void reload();
        } });
        const options = (name, fallback) => {
            const values = fields.widget(name)?.options?.values;
            return Array.isArray(values) && values.length ? values : fallback;
        };
        field(settings.content, "variant_policy", "采样版本", { options: options("variant_policy", [
            "优先二采（无则退回一采）", "仅一采", "仅二采",
        ]), change: () => void reload() });
        field(settings.content, "join_mode", "拼接方式", { options: options("join_mode", [
            "auto（参数一致无损直拷，否则重编码）", "copy（只允许无损直拷，参数不一致报错）", "reencode（统一重编码）",
        ]).map((value, index) => [value, ["自动", "仅无损直拷", "统一重编码"][index] || value]) });
        field(settings.content, "fps", "基准帧率", num(1, 240, 0.001));
        field(settings.content, "playback_speed", "恢复原速", { options: SPEED.map(([value, label]) =>
            [value, value === "1.0x" ? "不恢复" : value === "custom" ? label : `按 ${label} 切片恢复`]) });
        field(settings.content, "playback_speed_custom", "切片慢放倍率", { ...num(0.1, 1, 0.1),
            show: () => read("playback_speed") === "custom" });
        field(settings.content, "output_name", "输出文件名", { placeholder: "留空自动命名" });
    }

    const library = section(body, cut ? "裁切片段" : "镜头顺序", cut ? "clone" : "sort-amount-down");
    library.content.classList.add("ahv3-library");
    let cards = [], ticket = 0, loading = false, loadError = "";
    let dragId = "", merge = null, confirm = null, mutating = false;
    const project = createProjectBar({ parent: library.content, fields, cut, signal, toast, kind: clipKind,
        onSelect(changed) {
            if (changed && !cut) resetOrder();
            merge = confirm = null;
            void reload();
        } });
    const warning = cut ? el("div", "ahv3-summary is-error") : null;
    const message = el("div", "ahv3-summary", cut ? "" : "等待运行");
    message.setAttribute("role", "status");
    if (cut) {
        const saveFields = el("div", "ahv3-content ahv3-save-fields");
        field(saveFields, "save_preview_mp4", "生成 MP4 预览", { toggle: true });
        field(saveFields, "save_dtype", "存盘精度", { options: ["int8", "fp16"] });
        warning.hidden = true;
        warning.setAttribute("role", "status");
        message.hidden = true;
        library.content.append(saveFields, warning, message);
    }
    const summary = el("div", "ahv3-summary"), deck = el("div", "ahc-grid ahv3-deck");
    summary.setAttribute("role", "status");
    library.content.append(summary, deck);
    const refresh = button("刷新片段", "refresh", () => { void project.refresh(); void reload(); }, true);
    library.actions.append(refresh);
    const special = cut
        ? button("合并相邻片段", "link", () => { merge = merge ? null : new Set(); confirm = null; renderDeck(); })
        : button("按镜头序号", "sort-amount-down", () => { write("clip_order", ""); renderDeck(); });
    const confirmMerge = cut ? button("确认合并", "check", () => void mutate("merge")) : null;
    if (confirmMerge) library.actions.prepend(confirmMerge);
    library.actions.prepend(special);

    function resetOrder() { write("clip_order", ""); write("exclude_clips", ""); }
    const ids = () => cards.map(card => Number(card.segment_id));
    async function mutate(action, id) {
        if (mutating) return;
        const name = project.current();
        const chosen = [...(merge || [])].sort((a, b) => a - b);
        if (action === "merge" && (chosen.length < 2 || !adjacentSelection(chosen, ids()))) return;
        mutating = true;
        try {
            await post(`${LVM}/${action}`, action === "merge"
                ? { project: name, segment_ids: chosen } : { project: name, segment_id: id }, signal);
            if (signal.aborted || project.current() !== name) return;
            merge = confirm = null;
            toast(action === "merge" ? "片段已合并" : "片段已删除");
            void project.refresh();
            await reload();
        } catch (error) { toast(error.message, true); }
        finally { mutating = false; }
    }

    function appendCut(card) {
        const id = Number(card.segment_id);
        const marked = Boolean(merge?.has(id));
        const item = mediaCard(card.tag || `片段 ${id}`, `#${id}`, card.thumbnail_url,
            [card.width && card.height ? `${card.width}×${card.height}` : "",
                card.frames ? `${card.frames} 帧` : "", card.duration_sec ? `${Number(card.duration_sec).toFixed(2)} 秒` : ""].filter(Boolean).join(" / "));
        item.card.classList.toggle("is-current", marked);
        item.card.dataset.card = id;
        if (confirm === id) {
            const remove = button("永久删除", "trash", () => void mutate("delete", id));
            remove.classList.add("is-danger");
            item.tools.append(remove, button("取消", null, () => { confirm = null; renderDeck(); }));
        } else {
            if (merge) {
                const pick = button(marked ? "取消选择" : "选择合并", "check", () => {
                    merge = toggleMergeSelection(merge, id, ids());
                    renderDeck(`[data-card="${id}"] .ahv3-pick`);
                });
                pick.classList.add("ahv3-pick");
                pick.setAttribute("aria-pressed", String(marked));
                item.tools.append(pick);
            }
            const play = button("预览片段", "play", () => preview.open(`片段 ${id}`, card.mp4_url), true);
            play.disabled = !card.mp4_url;
            const remove = button("删除片段", "trash", () => { confirm = id; renderDeck(`[data-card="${id}"] .is-danger`); }, true);
            remove.classList.add("is-danger");
            remove.disabled = Boolean(merge);
            item.tools.append(play, remove);
        }
        deck.append(item.card);
    }

    function orderState() {
        const references = parseOrder(read("exclude_clips"));
        const excluded = new Set(references.map(reference => cards.find(card => String(card.clip_id) === reference)
            || cards.find(card => String(card.clip_id).includes(reference) || String(card.shot_tag || "").includes(reference)))
            .filter(Boolean).map(card => String(card.clip_id)));
        return { excluded, ...resolveDeckOrder(cards, read("clip_order"), excluded) };
    }
    function appendBuild(card, state) {
        const id = String(card.clip_id), index = state.joinIds.indexOf(id);
        const excluded = state.excluded.has(id);
        const name = card.shot_tag || "镜头";
        const item = mediaCard(name, index >= 0 ? `#${index + 1}` : excluded ? "已排除" : "无视频",
            card.thumbnail_url, [card.join_variant, card.video_width && card.video_height ? `${card.video_width}×${card.video_height}` : "",
                card.video_fps ? `${card.video_fps} fps` : "",
                card.video_duration_seconds ? `${Number(card.video_duration_seconds).toFixed(2)} 秒` : ""].filter(Boolean).join(" / "));
        const parentId = String(card.parent_clip_id || "").trim();
        const initial = parentId.toUpperCase().startsWith("[INITIAL");
        const parentName = state.namesById.get(parentId);
        const lineage = el("div", "ahv3-lineage", initial ? "首段" : parentId
            ? `衍生自 ${parentName || parentId.slice(-8)}` : "来源未记录");
        lineage.title = initial ? "首段生成，无接续来源" : parentId
            ? `衍生自 ${parentName ? `${parentName} · ` : ""}${parentId}` : "归档没有记录接续来源";
        item.tools.before(lineage);
        item.card.classList.toggle("is-skipped", excluded || !card.has_video);
        item.card.dataset.card = id;
        const selector = `[data-card="${CSS.escape(id)}"]`;
        function order(target, before, source, focus) {
            write("clip_order", moveCard(state.joinIds, source, target, before).join(","));
            renderDeck(focus);
        }
        const moves = el("div", "ahr-density ahv3-order-buttons");
        moves.setAttribute("role", "group");
        moves.setAttribute("aria-label", "调整镜头顺序");
        for (const [delta, label, mark, key, opposite] of [
            [-1, "向前移一位", "arrow-left", "before", "after"],
            [1, "向后移一位", "arrow-right", "after", "before"],
        ]) {
            const move = button(label, mark, () => {
                const next = index + delta;
                const focus = state.joinIds[next + delta] ? key : opposite;
                order(state.joinIds[next], delta < 0, id, `${selector} .ahv3-move-${focus}`);
            }, true);
            move.classList.add("is-seg", `ahv3-move-${key}`);
            move.disabled = index < 0 || !state.joinIds[index + delta];
            moves.append(move);
        }
        const toggle = button(excluded ? "加入拼接" : "排除", excluded ? "plus" : "minus", () => {
            if (excluded) state.excluded.delete(id);
            else state.excluded.add(id);
            write("exclude_clips", [...state.excluded].join(","));
            renderDeck(`${selector} .ahv3-include`);
        });
        toggle.classList.add("ahv3-include");
        toggle.disabled = !card.has_video;
        const video = card.join_video_url ?? (card.join_has_video === false ? "" : card.video_url);
        if (video) {
            const play = button(`播放 ${name}`, "play", () => preview.open(name, video, null, { autoplay: true }), true);
            play.className = "ahv3-cover-play";
            item.cover.append(play);
        }
        item.tools.classList.add("ahv3-build-actions");
        if (index >= 0) item.tools.append(moves);
        item.tools.append(toggle);
        item.card.draggable = index >= 0;
        item.card.addEventListener("dragstart", event => {
            if (dragId || index < 0) { event.preventDefault(); return; }
            dragId = id;
            event.dataTransfer.setData("text/plain", id);
            event.dataTransfer.effectAllowed = "move";
        });
        item.card.addEventListener("dragend", () => { dragId = ""; delete item.card.dataset.drop; });
        item.card.addEventListener("dragover", event => {
            if (index < 0 || !dragId || dragId === id) return;
            event.preventDefault();
            const bounds = item.card.getBoundingClientRect();
            item.card.dataset.drop = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
        });
        item.card.addEventListener("dragleave", event => {
            if (!item.card.contains(event.relatedTarget)) delete item.card.dataset.drop;
        });
        item.card.addEventListener("drop", event => {
            if (!dragId || dragId === id || index < 0) return;
            event.preventDefault();
            const source = dragId;
            dragId = "";
            order(id, item.card.dataset.drop !== "after", source);
        });
        deck.append(item.card);
    }

    function renderDeck(focus) {
        if (signal.aborted) return;
        deck.replaceChildren();
        refresh.disabled = loading;
        summary.classList.toggle("is-error", Boolean(loadError));
        deck.setAttribute("aria-busy", String(loading));
        if (cut) {
            confirmMerge.hidden = !merge;
            confirmMerge.disabled = !merge || merge.size < 2;
            const label = merge ? "取消合并" : "合并相邻片段";
            special.lastElementChild.textContent = label;
            special.title = label;
            special.setAttribute("aria-label", label);
            special.disabled = cards.length < 2 && !merge;
        } else {
            special.disabled = !read("clip_order");
        }
        if (!cards.length) {
            summary.textContent = loadError || (loading ? "正在读取项目…" : cut ? "暂无裁切片段" : "暂无归档镜头");
            deck.append(el("div", loading ? "ahv3-empty is-loading" : "ahv3-empty",
                loadError ? "无法读取片段，请刷新重试。" : loading ? "正在读取…" :
                    cut ? "选择源视频并运行裁切。" : "用 H3 片段保存节点归档生成结果。"));
            return;
        }
        if (cut) {
            summary.textContent = merge ? `已选 ${merge.size} 段相邻片段` : `${cards.length} 段`;
            cards.forEach(appendCut);
        } else {
            const state = orderState();
            state.namesById = new Map(cards.map(card => [String(card.clip_id), card.shot_tag]));
            const included = state.deck.filter(card => state.joinIds.includes(String(card.clip_id)));
            const seconds = included.reduce((total, card) => total + Number(card.video_duration_seconds || 0), 0);
            summary.textContent = `${included.length} / ${cards.length} 段参与拼接${seconds ? ` / 素材 ${seconds.toFixed(2)} 秒` : ""}`;
            state.deck.forEach(card => appendBuild(card, state));
        }
        if (focus) deck.querySelector(focus)?.focus({ preventScroll: true });
    }
    async function reload() {
        const current = ++ticket;
        const name = project.current(), kind = clipKind();
        loading = true;
        loadError = "";
        cards = [];
        renderDeck();
        try {
            const query = new URLSearchParams({ project: name });
            if (!cut) {
                query.set("asset_kind", kind);
                query.set("variant_policy", read("variant_policy") || "");
                query.set("probe", "1");
                query.set("join_view", "1");
            }
            const data = await fetchJson(`${cut ? `${LVM}/segments` : `${CLIPS}/list`}?${query}`, { signal });
            if (signal.aborted || current !== ticket) return;
            cards = cut ? [...(data.segments || [])].sort((a, b) => a.segment_id - b.segment_id)
                : (data.clips || []).map(card => ({ ...card, has_video: card.join_has_video ?? card.has_video }));
        } catch (error) {
            if (signal.aborted || current !== ticket) return;
            loadError = error.message;
        } finally {
            if (current === ticket) { loading = false; renderDeck(); }
        }
    }
    deck.addEventListener("keydown", event => {
        if (event.key === "Escape" && confirm != null) { confirm = null; renderDeck(); }
    });
    let showFilm;
    if (!cut) {
        const result = section(body, "成片预览", "play");
        result.content.classList.add("ahv3-result");
        result.content.append(message);
        const film = el("video", "ahv3-player");
        film.controls = film.playsInline = true;
        film.preload = "metadata";
        film.hidden = true;
        const download = el("a", "ahr-btn", "下载成片");
        download.hidden = true;
        result.actions.append(download);
        const details = el("details", "ahv3-report");
        const report = el("pre");
        details.append(el("summary", "", "拼接报告"), report);
        details.hidden = true;
        result.content.append(film, details);
        film.addEventListener("error", () => toast("无法播放成片，可下载后查看。", true));
        signal.addEventListener("abort", () => {
            film.pause();
            film.removeAttribute("src");
            film.load();
        }, { once: true });
        showFilm = data => {
            const href = outputUrl(data);
            film.pause();
            film.src = href;
            film.hidden = download.hidden = details.hidden = false;
            download.href = href;
            download.download = data.filename;
            report.textContent = [data.report, ...(data.warnings || [])].filter(Boolean).join("\n");
        };
    }
    const changeEvent = cut ? "amiaomiao_h3/lvm/changed" : "amiaomiao_h3/clip_bin/changed";
    const onChanged = event => {
        const name = event.detail?.project;
        if (!name || name === project.current()) { void project.refresh(); void reload(); }
    };
    api.addEventListener(changeEvent, onChanged);
    signal.addEventListener("abort", () => api.removeEventListener(changeEvent, onChanged), { once: true });
    addPanel(node, "h3_video_v3", root, cut ? 550 : 490);
    return {
        destroy: () => lifetime.abort(),
        controls: () => fields.refresh(),
        refresh() {
            fields.refresh();
            refreshDensity();
            visualMode();
            void project.refresh();
            void reload();
        },
        executed(data) {
            const row = (cut ? data?.h3v3_cut : data?.h3v3_film)?.[0];
            if (!row) return;
            message.textContent = cut ? `已保存 ${row.segments} 段至 ${row.project}${row.previews ? ` / ${row.previews} 个 MP4 预览` : ""}`
                : `${row.frames} 帧 / ${Number(row.seconds).toFixed(2)} 秒`;
            if (cut) {
                message.hidden = false;
                warning.textContent = row.warning || "";
                warning.hidden = !row.warning;
                void project.refresh();
                void reload();
            } else showFilm(row);
        },
    };
}

app.registerExtension({
    name: "Amiaomiao.H3.VideoWorkflowV3",
    async beforeRegisterNodeDef(type, data) {
        if (data.name !== CUT && data.name !== BUILD) return;
        const proto = type.prototype;
        for (const [event, action] of Object.entries({
            onNodeCreated() {
                this._h3VideoV3 = install(this, data.name === CUT);
                this._h3VideoV3.refresh();
            },
            onConfigure() {
                if (this.outputs?.length) {
                    // Let LiteGraph finish restoring downstream slots before disconnecting old links.
                    queueMicrotask(() => {
                        for (let index = (this.outputs?.length ?? 0) - 1; index >= 0; index--) {
                            this.removeOutput(index);
                        }
                    });
                }
                this._h3VideoV3?.refresh();
            },
            onConnectionsChange() { this._h3VideoV3?.controls(); },
            onExecuted(message) { this._h3VideoV3?.executed(message); },
            onRemoved() { this._h3VideoV3?.destroy(); },
        })) {
            const original = proto[event];
            proto[event] = function (...args) {
                const output = original?.apply(this, args);
                action.apply(this, args);
                return output;
            };
        }
    },
});
