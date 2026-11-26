"""Pure rules for the H3 reference hub: parse cards, number them, describe them.

No torch, no file access. The node and its tests share these functions, and the
panel mirrors the numbering in refs_web/refs_state.js.

Numbering follows ComfyUI's MiniMax H3 text encoder (comfy/text_encoders/minimax.py):
images become <Picture 1..>; every reference video whose soundtrack is connected
first takes the next <Audio j> and then <Video k>; standalone audio continues the
<Audio j> count afterwards. Outputs are packed so an empty slot never shifts a label.
"""
from __future__ import annotations

import json
import math

MAX_IMAGES = 9
MAX_VIDEOS = 3
MAX_AUDIOS = 3
VERSION = 1

VIDEO_SOURCES = ("segments", "uploads")

PURPOSES = {
    "image": [
        ("", "未设置"), ("subject.character", "角色"), ("subject.object", "物体"),
        ("subject.scene", "场景"), ("subject.costume", "服装"), ("frame.first", "首帧"),
        ("frame.key", "关键帧"), ("frame.last", "尾帧"), ("layout", "构图 / 分镜"),
        ("style", "画风参考"),
    ],
    "video": [
        ("", "未设置"), ("edit_source", "剪辑源"), ("continuation", "续写源"),
        ("motion", "动作 / 运镜参考"), ("subject.character", "角色"), ("style", "画风参考"),
    ],
    "audio": [
        ("", "未设置"), ("voice", "角色音色"), ("speech_reuse", "角色原声"),
        ("reuse", "直接复用"), ("ambience", "环境声参考"), ("music", "配乐参考"),
    ],
}
PURPOSE_LABELS = {kind: dict(rows) for kind, rows in PURPOSES.items()}
KIND_NAMES = {"image": "图片", "audio": "音频", "video": "视频"}
MIN_MAX_SIDE, MAX_MAX_SIDE = 64, 8192
# max_side 0 means "auto": decode straight to the canvas MiniMax H3 resizes reference videos to.
H3_BASE_SHORT_EDGE, H3_MAX_PIXELS, H3_CANVAS_MULTIPLE = 768, 768 * 1344, 32


def _text(value, limit=400):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("文字字段必须是字符串。")
    return " ".join(value.split())[:limit]


def _seconds(value, field):
    if value in (None, ""):
        return 0.0
    if isinstance(value, bool):
        raise ValueError(f"{field} 必须是数字。")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} 必须是数字。")
    if not math.isfinite(number):
        raise ValueError(f"{field} 必须是有限数字。")
    return number


def _file_entry(raw, index, kind):
    if not isinstance(raw, dict):
        raise ValueError(f"{kind} 卡片 {index + 1} 格式错误。")
    filename = raw.get("filename")
    if not isinstance(filename, str) or not filename.strip():
        raise ValueError(f"{kind} 卡片 {index + 1} 缺少文件名。")
    name = filename.strip().replace("\\", "/")
    if name.startswith("/") or ".." in name.split("/") or ":" in name:
        raise ValueError(f"{kind} 卡片 {index + 1} 的文件路径不安全。")
    subfolder = str(raw.get("subfolder") or "").strip().replace("\\", "/").strip("/")
    if ".." in subfolder.split("/") or ":" in subfolder:
        raise ValueError(f"{kind} 卡片 {index + 1} 的子目录不安全。")
    media_type = str(raw.get("type") or "input").lower()
    if media_type not in ("input", "output", "temp"):
        raise ValueError(f"{kind} 卡片 {index + 1} 的目录类型无效。")
    entry = {"filename": name, "subfolder": subfolder, "type": media_type}
    if kind == "audio":
        start = _seconds(raw.get("start"), "开始时间")
        duration = _seconds(raw.get("duration"), "时长")
        if duration < 0:
            raise ValueError(f"音频卡片 {index + 1} 的时长不能为负数。")
        entry["start"], entry["duration"] = start, duration
    return entry


def _video_entry(raw, index):
    if not isinstance(raw, dict):
        raise ValueError(f"视频卡片 {index + 1} 格式错误。")
    source = raw.get("source", "segments")
    if source not in VIDEO_SOURCES:
        raise ValueError(f"视频卡片 {index + 1} 的来源无效。")
    project = raw.get("project")
    if not isinstance(project, str) or not project.strip():
        raise ValueError(f"视频卡片 {index + 1} 未选择素材库。")
    segment_id = raw.get("segment_id")
    if isinstance(segment_id, bool) or not isinstance(segment_id, int) or segment_id < 1:
        raise ValueError(f"视频卡片 {index + 1} 未选择视频。")
    max_side = raw.get("max_side") or 0
    if isinstance(max_side, bool) or not isinstance(max_side, int) or not (
            max_side == 0 or MIN_MAX_SIDE <= max_side <= MAX_MAX_SIDE):
        raise ValueError(f"视频卡片 {index + 1} 的输出最长边无效。")
    # Library numbers shift after deletes and reorders; the key pins the actual file.
    key = raw.get("key")
    key = key.strip()[:200] if isinstance(key, str) else ""
    return {"source": source, "project": project.strip(), "segment_id": segment_id,
            "use_audio": bool(raw.get("use_audio", False)), "max_side": max_side, "key": key}


def library_key(source, record):
    """Identity of one library card that survives renumbering.

    Cut segments saved by a current build carry a uid that never changes. Older ones fall
    back to dir|saved_at; a merge that renames them keeps that old value in "aliases".
    """
    if not isinstance(record, dict):
        return ""
    if source == "uploads":
        return str(record.get("storage_name") or "")
    if record.get("uid"):
        return "uid:" + str(record["uid"])
    return "|".join(str(record.get(field) or "") for field in ("dir", "saved_at"))


def library_keys(source, record):
    """Every key that still names this record: the current one plus aliases from renames."""
    keys = {library_key(source, record)}
    if source != "uploads" and isinstance(record, dict):
        keys.add("|".join(str(record.get(field) or "") for field in ("dir", "saved_at")))
        aliases = record.get("aliases")
        if isinstance(aliases, list):
            keys.update(str(alias) for alias in aliases if alias)
    keys.discard("")
    return keys


def h3_canvas_long_side(width, height):
    """Long side of the canvas MiniMaxH3ReferenceToVideo resizes a reference video to.

    Mirrors adapt_canvas in comfy_extras/nodes_minimax_h3.py (768 short edge, 768*1344
    area cap, 32 grid). Decoding above this only costs memory: the frames are shrunk anyway.
    """
    width, height = int(width or 0), int(height or 0)
    if width <= 0 or height <= 0:
        return 0
    ratio = width / height
    nom_w, nom_h = ((H3_BASE_SHORT_EDGE * ratio, H3_BASE_SHORT_EDGE) if ratio >= 1.0
                    else (H3_BASE_SHORT_EDGE, H3_BASE_SHORT_EDGE / ratio))
    if nom_w * nom_h > H3_MAX_PIXELS:
        scale = math.sqrt(H3_MAX_PIXELS / (nom_w * nom_h))
        nom_w, nom_h = nom_w * scale, nom_h * scale
    grid = H3_CANVAS_MULTIPLE
    return max(max(grid, round(nom_w / grid) * grid), max(grid, round(nom_h / grid) * grid))


def align_17n5(frames):
    """Smallest 17n+5 frame count >= frames (at least 5): the grid H3 generates on."""
    frames = max(5, int(frames))
    return frames + (5 - frames % 17) % 17


def pad_to_17n5(frames):
    """How many copies of the last frame lift a reference clip onto the 17n+5 grid.

    MiniMaxH3ReferenceToVideo drops frames until a reference is 17n+5 long, which cuts
    real motion off its end. Repeating the last frame first means nothing real is lost.
    """
    frames = int(frames)
    return align_17n5(frames) - frames if frames > 0 else 0


def plan_length(follow_reference, manual_length, reference_frames):
    """(length for the native node, frames_cap for the decode trim).

    Off: the length widget as typed, no trim (0).
    On: the first video's frames aligned up to 17n+5, and the cap is that video's
    real frame count so the decoded tail the padding produced is cut away again.
    """
    if follow_reference:
        if not reference_frames:
            raise ValueError("开启了「跟随参考视频长度」，但素材包里没有启用的视频。请在视频页启用一个视频，或关闭这个开关。")
        return align_17n5(reference_frames), int(reference_frames)
    return int(manual_length), 0


# ---------- generation settings (H3 生成设置) ----------
# Ratios are long side : short side; orientation is chosen separately, so 21:9 also gives 9:21.
RATIOS = [("1:1", 1, 1), ("5:4", 5, 4), ("4:3", 4, 3), ("3:2", 3, 2), ("16:9", 16, 9),
          ("1.85:1", 1.85, 1), ("2:1", 2, 1), ("21:9", 21, 9), ("2.39:1", 2.39, 1)]
RATIO_NAMES = [name for name, _l, _s in RATIOS] + ["自定义"]
ORIENTATIONS = ["横", "竖"]
SIZE_MULTIPLE = 32
FPS = 24
SETTINGS_VERSION = 1


def _snap(value, multiple=SIZE_MULTIPLE):
    return max(multiple, int(round(value / multiple)) * multiple)


def plan_size(ratio, orientation, megapixels, custom_width=1344, custom_height=768):
    """(width, height) on the 32 grid. Like ResolutionSelector, megapixels * 1024 * 1024 is the area."""
    if ratio == "自定义":
        return _snap(custom_width), _snap(custom_height)
    entry = next((row for row in RATIOS if row[0] == ratio), None)
    if entry is None:
        raise ValueError(f"未知的画幅比例：{ratio}")
    _name, long_side, short_side = entry
    area = float(megapixels) * 1024 * 1024
    scale = math.sqrt(area / (long_side * short_side))
    width, height = _snap(long_side * scale), _snap(short_side * scale)
    return (height, width) if orientation == "竖" and width != height else (width, height)


def scaled_size(width, height, factor):
    """Second-pass size: first-pass size times the upscale factor, on the 32 grid."""
    return _snap(width * float(factor)), _snap(height * float(factor))


def build_settings(seconds, follow_reference, ratio, orientation, megapixels, upscale,
                   pad_reference=True, custom_width=1344, custom_height=768):
    """The GENERATION_SETTINGS value one node hands to both Ref2V passes."""
    seconds = float(seconds)
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("视频时长必须是大于 0 的秒数。")
    width, height = plan_size(ratio, orientation, megapixels, custom_width, custom_height)
    width2, height2 = scaled_size(width, height, upscale)
    return {"version": SETTINGS_VERSION, "seconds": seconds, "length": align_17n5(round(seconds * FPS)),
            "follow_reference": bool(follow_reference), "pad_reference": bool(pad_reference),
            "width": width, "height": height, "width_2": width2, "height_2": height2,
            "ratio": ratio, "orientation": orientation, "megapixels": float(megapixels),
            "upscale": float(upscale)}


def check_settings(settings):
    if not isinstance(settings, dict) or settings.get("version") != SETTINGS_VERSION:
        raise ValueError("生成设置格式不对：请连接「H3 生成设置」节点的生成设置输出。")
    return settings


def parse_document(raw):
    """Validate the panel's JSON. Raises ValueError with a readable Chinese message."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        data = {}
    elif isinstance(raw, str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"素材记录不是有效 JSON：{exc.msg}")
    elif isinstance(raw, dict):
        data = raw
    else:
        raise ValueError("素材记录格式错误。")
    if not isinstance(data, dict):
        raise ValueError("素材记录格式错误。")
    cards = {}
    for kind, limit in (("image", MAX_IMAGES), ("audio", MAX_AUDIOS), ("video", MAX_VIDEOS)):
        rows = data.get(kind + "s", [])
        if not isinstance(rows, list) or len(rows) > 64:
            raise ValueError(f"{kind} 列表格式错误。")
        parsed = []
        for index, row in enumerate(rows):
            entry = _video_entry(row, index) if kind == "video" else _file_entry(row, index, kind)
            purpose = row.get("purpose") or ""
            if purpose not in PURPOSE_LABELS[kind]:
                purpose = ""
            entry.update(id=str(row.get("id") or f"{kind}-{index}")[:64],
                         name=_text(row.get("name"), 60), purpose=purpose,
                         note=_text(row.get("note")), skip=bool(row.get("skip", False)))
            parsed.append(entry)
        active = [entry for entry in parsed if not entry["skip"]]
        if len(active) > limit:
            raise ValueError("启用的%s超过上限 %d 个，请先停用多余卡片。" % (KIND_NAMES[kind], limit))
        cards[kind] = parsed
    return {"version": VERSION, "images": cards["image"], "audios": cards["audio"],
            "videos": cards["video"], "ui": data.get("ui") if isinstance(data.get("ui"), dict) else {}}


def assign_labels(doc):
    """Return the active cards in output order with their ports and prompt labels.

    Each row: {"kind", "card", "slot", "port", "label", "audio_port", "audio_label"}.
    port is the native MiniMaxH3ReferenceToVideo input the card feeds (ref_image_N,
    ref_video_N, ref_audio_N; a soundtrack feeds ref_video_audio_N paired with ref_video_N).
    label is what the prompt calls it: soundtracks and standalone audio share <Audio j>.
    """
    rows = []
    images = [card for card in doc["images"] if not card["skip"]]
    videos = [card for card in doc["videos"] if not card["skip"]]
    audios = [card for card in doc["audios"] if not card["skip"]]
    for slot, card in enumerate(images):
        rows.append({"kind": "image", "card": card, "slot": slot, "port": f"ref_image_{slot}",
                     "label": f"<Picture {slot + 1}>", "audio_port": None, "audio_label": None})
    audio_count = 0
    for slot, card in enumerate(videos):
        audio_label = None
        if card["use_audio"]:
            audio_count += 1
            audio_label = f"<Audio {audio_count}>"
        rows.append({"kind": "video", "card": card, "slot": slot, "port": f"ref_video_{slot}",
                     "label": f"<Video {slot + 1}>",
                     "audio_port": f"ref_video_audio_{slot}" if audio_label else None,
                     "audio_label": audio_label})
    for slot, card in enumerate(audios):
        audio_count += 1
        rows.append({"kind": "audio", "card": card, "slot": slot, "port": f"ref_audio_{slot}",
                     "label": f"<Audio {audio_count}>", "audio_port": None, "audio_label": None})
    return rows


def manifest_text(rows):
    """The text a user pastes into a prompt-writing skill."""
    if not rows:
        return "参考素材：无。"
    lines = ["参考素材（编号以此为准）："]
    for row in rows:
        card = row["card"]
        name = card["name"] or KIND_NAMES[row["kind"]] + str(row["slot"] + 1)
        purpose = PURPOSE_LABELS[row["kind"]].get(card["purpose"], "") if card["purpose"] else ""
        parts = [part.rstrip("。") for part in (purpose, card["note"]) if part]
        if row["audio_label"]:
            lines.append(f"{row['audio_label']} {name}的 Video Audio（{row['label']} 的原音轨）。")
        lines.append(f"{row['label']} {name}" + ("：" + "。".join(parts) if parts else "") + "。")
    return "\n".join(lines)


def refs_payload(doc, rows):
    """Structured description for a downstream prompt node (H3_REFS)."""
    items = []
    for row in rows:
        card = row["card"]
        items.append({"id": card["id"], "kind": row["kind"], "label": row["label"],
                      "port": row["port"], "audio_port": row["audio_port"],
                      "audio_label": row["audio_label"], "name": card["name"],
                      "purpose": card["purpose"], "note": card["note"]})
    return {"version": VERSION, "items": items, "manifest": manifest_text(rows)}
