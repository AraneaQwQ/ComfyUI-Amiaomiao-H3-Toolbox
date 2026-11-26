"""Pure rules for the v2 Clip Picker / Saver (no torch, no ComfyUI).

v2 keeps the dual-variant folder layout (latent_一采 / latent_二采 ...), so cards it saves
are also readable by the original Dual Picker and the Long Builder. It also reads cards
from the original single Saver (latent.safetensors) as 一采-only cards.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

MODE_NEW = "全新段落"
MODE_CONTINUE = "接续前段"
MODES = [MODE_CONTINUE, MODE_NEW]
# Card variants (folder and meta keys, shared with the original Dual nodes and Long Builder).
PASS_ONE = "一采"
PASS_TWO = "二采"
# Workflow switch on the Picker: which kind of workflow this node sits in.
FLOW_DUAL = "双采"     # 一采 + 二采放大, two sampling passes
FLOW_SINGLE = "单采"   # one sampling pass only
FLOWS = [FLOW_DUAL, FLOW_SINGLE]
LATEST = "latest"
LINK_VERSION = 1
# Join settings the Picker hands to every Motion Context (same grid as the MC node offers).
CONTEXT_LENGTHS = ["5", "22", "39", "56"]
DEFAULT_CONTEXT_LENGTH = "22"
DEFAULT_AUDIO_LENGTH = 24
AUDIO_LENGTH_MAX = 240


def normalize_context(context_length: Any = DEFAULT_CONTEXT_LENGTH, enable_audio: Any = False,
                      audio_length: Any = DEFAULT_AUDIO_LENGTH) -> Dict[str, Any]:
    """{video_frames, audio, audio_frames}; off-grid or junk values fall back to the defaults."""
    frames = str(context_length).strip()
    if frames not in CONTEXT_LENGTHS:
        frames = DEFAULT_CONTEXT_LENGTH
    try:
        audio_frames = int(audio_length)
    except (TypeError, ValueError):
        audio_frames = DEFAULT_AUDIO_LENGTH
    audio_frames = min(AUDIO_LENGTH_MAX, max(0, audio_frames))
    return {"video_frames": int(frames), "audio": bool(enable_audio), "audio_frames": audio_frames}


def normalize_mode(value: Any) -> str:
    """Map old Picker mode strings onto the two v2 modes.

    Auto and Strict Chaining both continue; Force Initial starts fresh.
    """
    text = str(value or "").strip()
    if text == MODE_NEW or text.startswith("Force Initial"):
        return MODE_NEW
    return MODE_CONTINUE


def normalize_passes(value: Any) -> str:
    """双采 / 单采; the first build of v2 stored 二采 / 一采."""
    return FLOW_SINGLE if str(value or "").strip() in (FLOW_SINGLE, PASS_ONE) else FLOW_DUAL


def video_variant(flow: Any) -> str:
    """The card variant a finished video belongs to in this workflow."""
    return PASS_TWO if normalize_passes(flow) == FLOW_DUAL else PASS_ONE


def is_latest(selection: Any) -> bool:
    return str(selection or "").strip().lower() in ("", "latest", "auto", "default", "0")


def resolve_target(clips: List[Dict[str, Any]], selection: Any) -> Optional[Dict[str, Any]]:
    """The card to continue from. clips are newest first. None = nothing to continue."""
    usable = [c for c in clips if isinstance(c, dict) and c.get("clip_id")]
    if not usable:
        return None
    if is_latest(selection):
        return usable[0]
    wanted = str(selection).strip()
    for clip in usable:
        if clip["clip_id"] == wanted:
            return clip
    for clip in usable:
        if str(clip.get("shot_tag") or "").strip() == wanted:
            return clip
    raise ValueError(f"固定接续的片段「{wanted}」已不在项目里（可能被删除）。请在片段选择 v2 上打开“跟随最新”，或点一张卡片重新固定。")


def shot_label(clip: Optional[Dict[str, Any]]) -> str:
    if not clip:
        return ""
    return str(clip.get("shot_tag") or "").strip() or str(clip.get("clip_id") or "")


def variant_summary(clip: Dict[str, Any]) -> Dict[str, float]:
    """{"一采": seconds, "二采": seconds} for the variants this card really has."""
    out: Dict[str, float] = {}
    variants = clip.get("variants")
    if isinstance(variants, dict) and variants:
        for name in ("一采", "二采"):
            v = variants.get(name)
            if isinstance(v, dict) and v.get("has_latent"):
                out[name] = float(v.get("duration_seconds") or 0)
    elif clip.get("clip_id"):
        out["一采"] = float(clip.get("duration_seconds") or 0)
    return out


def make_link(project: str, mode: str, target: Optional[Dict[str, Any]], note: str = "",
              passes: str = FLOW_DUAL, context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """What the Picker hands to the Saver: where to save and what this run continued from."""
    return {
        "version": LINK_VERSION,
        "project": project,
        "mode": mode,
        "passes": normalize_passes(passes),
        "parent_clip_id": str(target.get("clip_id")) if target else "",
        "parent_shot": shot_label(target),
        "note": note,
        "context": dict(context or normalize_context()),
    }


def check_link(link: Any) -> Dict[str, Any]:
    if not isinstance(link, dict) or link.get("version") != LINK_VERSION or not str(link.get("project") or "").strip():
        raise ValueError("接续信息格式不对：请连接「H3 片段选择 v2」的接续信息输出。")
    return link


def picker_status(project: str, mode: str, target: Optional[Dict[str, Any]], empty_fallback: bool,
                  missing_second: bool, passes: str = FLOW_DUAL) -> str:
    """One line for the node: what this run is about to do."""
    if mode == MODE_NEW:
        return f"全新段落 · 保存到「{project}」"
    if target is None:
        return f"「{project}」里还没有片段，本次按全新段落生成" if empty_fallback else f"全新段落 · 「{project}」"
    summary = variant_summary(target)
    if normalize_passes(passes) == FLOW_SINGLE:
        summary = {k: v for k, v in summary.items() if k == PASS_ONE}
    parts = [f"{name} {seconds:.1f} 秒" if seconds else name for name, seconds in summary.items()]
    text = f"接续 {shot_label(target)}（{' / '.join(parts)}）"
    if missing_second and normalize_passes(passes) == FLOW_DUAL:
        text += " · 这一段没有二采，二采按全新段落生成"
    return text


def saver_status(shot: str, link: Dict[str, Any], variants: List[str]) -> str:
    text = f"已存为 {shot}"
    if link.get("parent_shot"):
        text += f" · 接自 {link['parent_shot']}"
    if variants:
        text += f" · {' + '.join(variants)}"
    return text
