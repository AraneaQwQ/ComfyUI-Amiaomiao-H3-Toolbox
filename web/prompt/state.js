export const NODE_ID = "AmiaomiaoH3_PromptComposer";
export const FIELDS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
export const clone = value => JSON.parse(JSON.stringify(value));
export const uid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
export function defaultDocument() {
    return {
        version: 1, mode: "compose", native_text: "", duration_ms: 10000,
        tasks: ["reference generation"], summary: "", style: "", assets: [], definitions: [],
        shots: [{ id: "shot-first", start_ms: 0, runs: [] }],
        mc: { enabled: false, mode: "continue", fps: 24, overlap_frames: null, trim_frames: null, carry: [], source: "manual" },
        soundscape: "", music: { enabled: false, text: "" }, overrides: {},
        ui: { assets_collapsed: false, asset_groups_collapsed: {} },
    };
}
export function parseDocument(raw) {
    const value = typeof raw === "string" ? JSON.parse(raw) : clone(raw);
    if (!value || Array.isArray(value) || (value.version ?? 1) !== 1) throw new Error("不支持的草稿版本");
    const doc = { ...defaultDocument(), ...value };
    if (!["compose", "native"].includes(doc.mode)) throw new Error("输入模式无效");
    for (const field of ["shots", "definitions", "assets"]) {
        if (!Array.isArray(doc[field]) || (field === "shots" && !doc[field].length)) throw new Error(`${field} 格式错误`);
        const ids = doc[field].map(item => item?.id);
        if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new Error(`${field} ID 无效或重复`);
    }
    doc.mc = { ...defaultDocument().mc, ...doc.mc };
    doc.music = { enabled: false, text: "", ...doc.music };
    doc.ui = { ...defaultDocument().ui, ...doc.ui };
    doc.ui.asset_groups_collapsed = { ...doc.ui.asset_groups_collapsed };
    doc.assets = doc.assets.map(asset => Object.hasOwn(asset, "loader_slot")
        ? { ...asset, slot: loaderReferenceSlot(asset), mapping_changed: false } : asset);
    return doc;
}
export function loaderReferenceSlot(asset) {
    return !asset.skip && !asset.ambiguous && Number.isInteger(asset.loader_slot) && asset.loader_slot >= 0
        ? asset.loader_slot + 1 : null;
}
export function addShot(doc) {
    const shot = { id: uid("shot"), start_ms: null, runs: [] };
    doc.shots.push(shot);
    return shot;
}
export function addDefinitionFromAsset(doc, assetId, { kind, purpose, description = "" }) {
    const asset = doc.assets.find(item => item.id === assetId);
    const allowed = { Subject: ["image", "video"], Picture: ["image"], Video: ["video"], Audio: ["audio", "video"] };
    if (!asset || asset.skip || asset.missing || !allowed[kind]?.includes(asset.kind)
        || (kind === "Audio" && asset.kind === "video" && !asset.audio_enabled)) {
        throw new Error("定义用途与可用素材不匹配");
    }
    const definition = {
        id: uid("definition"), name: asset.alias || asset.label || "", kind, purpose, description,
        sources: [{ asset_id: asset.id, role: "" }],
        relation: kind === "Audio" ? "reference" : "fully_preserved", keep: "", change: "", scope: [],
    };
    doc.definitions.push(definition);
    return definition;
}
export function removeShot(doc, id) {
    if (id === doc.shots[0].id) return false;
    const index = doc.shots.findIndex(shot => shot.id === id);
    if (index < 1) return false;
    doc.shots.splice(index, 1);
    // Scope references intentionally remain invalid until the user resolves them.
    return true;
}
export function moveShot(doc, id, direction) {
    const index = doc.shots.findIndex(shot => shot.id === id), next = index + direction;
    if (index < 1 || next < 1 || next >= doc.shots.length) return false;
    [doc.shots[index], doc.shots[next]] = [doc.shots[next], doc.shots[index]];
    return true;
}
export function shotLabels(doc) {
    const cut = doc.mc.enabled && doc.mc.mode === "cut";
    return [
        ...(cut ? [{ id: "mc-carry", label: "Shot 1 · 承接" }] : []),
        ...doc.shots.map((shot, index) => ({ id: shot.id, label: `Shot ${index + (cut ? 2 : 1)}` })),
    ];
}
export function mergeAssets(previous, incoming) {
    const old = new Map(previous.map(a => [a.id, a])), fresh = new Set(incoming.map(a => a.id));
    let added = 0, updated = 0;
    const assets = incoming.map(asset => {
        const before = old.get(asset.id);
        if (!before) added++;
        else if (JSON.stringify({ ...before, slot: null }) !== JSON.stringify({ ...asset, slot: null })) updated++;
        const fromLoader = Object.hasOwn(asset, "loader_slot");
        return { ...before, ...asset, slot: fromLoader ? loaderReferenceSlot(asset) : before?.slot ?? asset.slot,
            mapping_changed: !fromLoader && (!!before?.mapping_changed || (before?.slot != null &&
                asset.slot != null && before.slot !== asset.slot)),
            audio_slot: before?.audio_slot ?? null, audio_enabled: before?.audio_enabled ?? false,
            alias: before?.alias ?? "" };
    });
    for (const asset of previous) if (!fresh.has(asset.id)) assets.push({ ...asset, missing: true });
    return { assets, added, updated, missing: assets.filter(a => a.missing || a.skip).length };
}
const widget = (node, name) => node.widgets?.find(w => w.name === name)?.value;
export function selectorsFromGraph(nodes) {
    const selectors = [], errors = [];
    for (const node of nodes) {
        const type = node.type ?? node.comfyClass ?? "", original = type.replace(/^AmiaomiaoH3_/, "");
        const base = { node_id: String(node.id), node_title: node.title || type };
        if (["H3 Image Reference Loader", "H3 Audio Reference Loader"].includes(original)) {
            try {
                const entries = JSON.parse(widget(node, "media_files") || "[]");
                selectors.push({ ...base, kind: original.includes("Image") ? "image" : "audio", entries });
            } catch { errors.push(`${base.node_title} 的素材记录不是有效 JSON`); }
        } else if (original === "H3 Segment Picker") {
            selectors.push({ ...base, kind: "video", family: "lvm", legacy: type === original,
                project: widget(node, "project_name"), segment_id: Number(widget(node, "segment_id")),
                source_mode: widget(node, "source_mode") || "segments" });
        } else if (["MiniMaxClipBinPicker", "MiniMaxClipBinDualPicker"].includes(original)) {
            selectors.push({ ...base, kind: "video", family: "clipstream", legacy: type === original,
                project: widget(node, "project_name"), selection: widget(node, "clip_selection") || "latest",
                dual: original.includes("Dual"), mode: widget(node, "mode") || "" });
        }
    }
    return { selectors, errors };
}
export function directSlot(asset, graph) {
    if (asset.ambiguous || asset.skip) return null;
    if (Object.hasOwn(asset, "loader_slot")) return loaderReferenceSlot(asset);
    const node = graph.getNodeById(Number(asset.node_id)) ?? graph.getNodeById(asset.node_id);
    // 视频节点没有 loader_slot，需要看节点的 IMAGE 输出
    const outputSlot = asset.loader_slot ?? node?.outputs?.findIndex(o => o.type === "IMAGE" || o.type === "VIDEO" || o.type === "AUDIO");
    const output = node?.outputs?.[outputSlot];
    const slots = new Set();
    for (const id of output?.links ?? []) {
        const link = graph.links?.[id];
        const target = graph.getNodeById(link?.target_id);
        if (!target || !String(target.type).includes("MiniMaxH3")) continue;
        const name = target.inputs?.[link.target_slot]?.name ?? "";
        const pattern = {
            image: /(?:^|\.)ref_image_(\d+)$/,
            audio: /(?:^|\.)ref_audio_(\d+)$/,
            video: /(?:^|\.)ref_video_(\d+)$/
        }[asset.kind];
        const match = name.match(pattern);
        if (match) slots.add(Number(match[1]) + 1);
    }
    return slots.size === 1 ? [...slots][0] : null;
}

export const ASSET_PURPOSES = {
    image: [
        ["Picture:first frame", "首帧 / 关键帧"],
        ["Subject:character", "角色外貌"],
        ["Subject:environment", "场景环境"],
        ["Subject:costume", "服装道具"],
        ["Subject:style", "画风效果"],
    ],
    audio: [
        ["Audio:voice", "音色参考"],
        ["Audio:fully_copy", "原声复制"],
        ["Audio:ambience", "环境声"],
        ["Audio:music", "观众配乐"],
    ],
    video: [
        ["Video:camera", "运镜与节奏"],
        ["Video:continuation", "接续源"],
        ["Video:editing", "编辑源"],
        ["Subject:motion", "动作姿态"],
    ],
};

export function applyAssetPurpose(doc, assetId, purposeKey) {
    const asset = doc.assets.find(a => a.id === assetId);
    if (!asset || asset.skip || asset.missing) return;
    const [kind, purpose] = purposeKey.split(":");
    if (kind === "Picture") {
        doc.definitions.push({
            id: uid("definition"), name: asset.alias || asset.label || "", kind: "Picture",
            purpose, description: ``, sources: [{ asset_id: asset.id, role: "" }],
            relation: "fully_preserved", keep: "", change: "", scope: []
        });
    } else if (kind === "Video") {
        doc.definitions.push({
            id: uid("definition"), name: asset.alias || asset.label || "", kind: "Video",
            purpose: purpose === "camera" ? "camera and pacing reference" : purpose + " source",
            description: ``, sources: [{ asset_id: asset.id, role: "" }],
            relation: purpose === "camera" ? "weak_reference" : "fully_preserved", keep: "", change: "", scope: []
        });
    } else if (kind === "Audio") {
        doc.definitions.push({
            id: uid("definition"), name: asset.alias || asset.label || "", kind: "Audio",
            purpose, description: ``, sources: [{ asset_id: asset.id, role: "" }],
            relation: purpose === "fully_copy" ? "fully_copy" : "reference", keep: "", change: "", scope: []
        });
    } else if (kind === "Subject") {
        // 同 purpose 的 Subject 自动合并
        let subject = doc.definitions.find(d => d.kind === "Subject" && d.purpose === purpose);
        if (!subject) {
            subject = {
                id: uid("definition"), name: asset.alias || asset.label || "", kind: "Subject",
                purpose, description: ``, sources: [],
                relation: "fully_preserved", keep: "", change: "", scope: []
            };
            doc.definitions.push(subject);
        }
        if (!subject.sources.some(s => s.asset_id === asset.id)) {
            subject.sources.push({ asset_id: asset.id, role: "" });
        }
    }
}

export function autoDefineAssets(doc) {
    // 只为尚未分配用途的素材生成默认 Picture/Video/Audio 定义
    const usedAssetIds = new Set(doc.definitions.flatMap(d => d.sources.map(s => s.asset_id)));
    for (const asset of doc.assets) {
        if (asset.skip || asset.missing || usedAssetIds.has(asset.id)) continue;
        if (asset.kind === "image") {
            applyAssetPurpose(doc, asset.id, "Picture:first frame");
        } else if (asset.kind === "video") {
            applyAssetPurpose(doc, asset.id, "Video:camera");
            if (asset.audio_enabled) {
                applyAssetPurpose(doc, asset.id, "Audio:fully_copy");
            }
        } else if (asset.kind === "audio") {
            applyAssetPurpose(doc, asset.id, "Audio:voice");
        }
    }
}

export function mcCandidates(nodes) {
    return nodes.filter(n => String(n.type).replace(/^AmiaomiaoH3_/, "") === "MiniMaxH3MotionContextClipStream")
        .map(n => ({ id: String(n.id), label: n.title || String(n.id),
            requested: widget(n, "context_length"),
            hasContext: n.inputs?.some(i => ["context_frames", "context_latent"].includes(i.name) && i.link != null) }));
}
export function runsFromText(text) {
    const parts = [], regex = /\{\{(ref|def):([^{}]+)\}\}/g;
    let start = 0, match;
    while ((match = regex.exec(text))) {
        if (match.index > start) parts.push({ kind: "text", text: text.slice(start, match.index) });
        parts.push({ kind: "ref", target: match[1], id: match[2] });
        start = regex.lastIndex;
    }
    if (start < text.length) parts.push({ kind: "text", text: text.slice(start) });
    return parts;
}
export function textFromRuns(runs) {
    return runs.map(run => run.kind === "ref" ? `{{${run.target || "ref"}:${run.id}}}` : run.text || "").join("");
}
export function createHistory(initial) {
    let past = [], future = [], last = clone(initial), lastKey = null, lastAt = 0;
    return {
        record(next, key = null) {
            const now = Date.now(), serialized = JSON.stringify(next);
            if (serialized === JSON.stringify(last)) return;
            if (!key || key !== lastKey || now - lastAt > 650) past.push(clone(last));
            past = past.slice(-80); future = []; last = clone(next); lastKey = key; lastAt = now;
        },
        undo(current) { if (!past.length) return null; future.push(clone(current)); last = past.pop(); lastKey = null; return clone(last); },
        redo(current) { if (!future.length) return null; past.push(clone(current)); last = future.pop(); lastKey = null; return clone(last); },
    };
}
