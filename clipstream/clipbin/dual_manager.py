"""Dual-variant Clip Bin manager.

Handles saving and loading clips that contain two latent variants:
  - 一采 (1-pass): single sampler pass, lower resolution/faster
  - 二采 (2-pass): dual sampler pass with upscale, higher quality

Folder structure per clip:
    project_name/
      clip_{timestamp}_{slug}/
        latent_一采.safetensors
        latent_二采.safetensors
        first_frame_一采.png
        tail_frame_一采.png
        first_frame_二采.png
        tail_frame_二采.png
        preview.png
        video_一采.mp4  (optional)
        video_二采.mp4  (optional)
        meta.json
"""

import os
import json
import logging
import shutil
import tempfile
from uuid import uuid4
from dataclasses import dataclass, asdict, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import torch
from PIL import Image, ImageDraw

try:
    import numpy as np
except ImportError:
    np = None

try:
    from safetensors.torch import load_file as st_load, save_file as st_save
except ImportError:
    st_load = None
    st_save = None

from ._shared import (
    _unpack_latent,
    pack_av_latent,
    latent_steps_to_pixel_frames,
    _standardize_image_tensor,
    _standardize_audio_dict,
)
from .clip_bin_manager import (
    get_project_dir,
    require_clip_kind,
    next_shot_tag,
    project_locked,
    load_project_index,
    upsert_clip_into_index,
    tensor_to_pil,
    pil_to_tensor,
    create_placeholder_card,
    create_side_by_side_preview,
    resolve_source_video_path,
    probe_video_duration,
    encode_images_to_mp4,
    list_projects,
    atomic_write_json,
)

logger = logging.getLogger("minimax_clip_bin_dual")

VARIANTS = ("一采", "二采")


@dataclass
class VariantMeta:
    """Metadata for a single variant (一采 or 二采) within a dual clip."""
    has_latent: bool = False
    frames: int = 0
    duration_seconds: float = 0.0
    # "computed" (latent steps / fps estimate) or "probed" (measured from the real video file)
    duration_source: str = "computed"
    resolution: List[int] = field(default_factory=list)
    video_shape: List[int] = field(default_factory=list)
    audio_shape: Optional[List[int]] = None
    has_video: bool = False
    video_file: Optional[str] = None


@dataclass
class DualClipMeta:
    """Metadata for a dual-variant clip."""
    clip_id: str
    project_name: str = "Default_Project"
    shot_tag: str = "Shot 1"
    prompt: str = ""
    created_at: str = ""
    parent_clip_id: Optional[str] = None
    variants: Dict[str, VariantMeta] = field(default_factory=dict)
    notes: Optional[str] = None

    @property
    def variant_labels(self) -> List[str]:
        """Returns which variants are present, e.g. ['一采', '二采']."""
        return [v for v in VARIANTS if self.variants.get(v, VariantMeta()).has_latent]


def _variant_slug(variant: str) -> str:
    """Returns the file suffix for a variant."""
    return variant  # "一采" or "二采"


@project_locked
def save_dual_clip_asset(
    latent_a: Optional[Dict[str, Any]],
    latent_b: Optional[Dict[str, Any]],
    images_a: Optional[torch.Tensor] = None,
    images_b: Optional[torch.Tensor] = None,
    audio_a: Optional[Dict[str, Any]] = None,
    audio_b: Optional[Dict[str, Any]] = None,
    project_name: str = "Default_Project",
    shot_tag: str = "Auto",
    prompt: str = "",
    parent_clip_id: str = "",
    video_file_name_a: Any = "",
    video_file_name_b: Any = "",
    save_video: bool = True,
    fps: float = 24.0,
    workflow_mode: str = "",
    _staging_dir: Optional[str] = None,
    _target_id: str = "",
) -> Tuple[DualClipMeta, str, Image.Image]:
    """Saves a dual-variant clip asset.
    
    Args:
        latent_a: 一采 latent (or None if not generated)
        latent_b: 二采 latent (or None if not generated)
        images_a: 一采 decoded frames
        images_b: 二采 decoded frames
        audio_a: 一采 audio dict
        audio_b: 二采 audio dict
        project_name: project pool name
        shot_tag: shot label
        prompt: generation prompt
        parent_clip_id: lineage tracking
        video_file_name_a: source video path for 一采
        video_file_name_b: source video path for 二采
        save_video: whether to archive/encode video
        fps: frame rate for duration calculation
    
    Returns:
        (DualClipMeta, clip_dir_path, preview_pil_image)
    """
    if latent_a is None and latent_b is None:
        raise ValueError("DualSaver: at least one variant (一采 or 二采) must be provided.")

    now_dt = datetime.now()
    timestamp_str = now_dt.strftime("%Y%m%d_%H%M%S_%f")
    time_display = now_dt.strftime("%Y-%m-%d %H:%M:%S")

    # Resolve shot tag
    actual_shot = (shot_tag or "").strip()
    if actual_shot.startswith("Auto") or not actual_shot:
        actual_shot = next_shot_tag(project_name, "dual")

    tag_slug = "".join(c for c in actual_shot if c.isalnum() or c in ("_", "-")).strip() or "Shot"
    clip_id = _target_id or f"clip_{timestamp_str}_{tag_slug}"

    project_dir = get_project_dir(project_name)
    clip_dir = _staging_dir if _staging_dir else os.path.join(project_dir, clip_id)
    os.makedirs(clip_dir, exist_ok=True)

    meta_obj = DualClipMeta(
        clip_id=clip_id,
        project_name=project_name,
        shot_tag=actual_shot,
        prompt=prompt if isinstance(prompt, str) else str(prompt),
        created_at=time_display,
        parent_clip_id=parent_clip_id if isinstance(parent_clip_id, str) and parent_clip_id else None,
    )

    # Process each variant
    variant_configs = [
        ("一采", latent_a, images_a, audio_a, video_file_name_a),
        ("二采", latent_b, images_b, audio_b, video_file_name_b),
    ]

    preview_pil = None
    preview_for_gallery = None

    for variant_name, latent, images, audio, video_src in variant_configs:
        if latent is None:
            meta_obj.variants[variant_name] = VariantMeta(has_latent=False)
            continue

        video, audio_lat = _unpack_latent(latent)
        if video is None:
            meta_obj.variants[variant_name] = VariantMeta(has_latent=False)
            continue

        images = _standardize_image_tensor(images)
        audio = _standardize_audio_dict(audio)

        vmeta = VariantMeta(has_latent=True)
        vmeta.frames = latent_steps_to_pixel_frames(video.shape[2])
        vmeta.duration_seconds = round(vmeta.frames / float(fps), 2)
        vmeta.resolution = [video.shape[4] * 8, video.shape[3] * 8]
        vmeta.video_shape = list(video.shape)
        vmeta.audio_shape = list(audio_lat.shape) if audio_lat is not None else None

        # Save latent
        latent_file = os.path.join(clip_dir, f"latent_{variant_name}.safetensors")
        video_cpu = video.detach().cpu().contiguous()
        audio_cpu = audio_lat.detach().cpu().contiguous() if audio_lat is not None else None
        tensors = {"video": video_cpu}
        if audio_cpu is not None:
            tensors["audio"] = audio_cpu

        if st_save is not None:
            st_save(tensors, latent_file, metadata={
                "clip_id": clip_id,
                "variant": variant_name,
                "created_at": time_display,
            })
        else:
            torch.save(tensors, latent_file)

        # Save keyframes
        first_path = os.path.join(clip_dir, f"first_frame_{variant_name}.png")
        tail_path = os.path.join(clip_dir, f"tail_frame_{variant_name}.png")

        if images is not None and isinstance(images, torch.Tensor) and images.ndim == 4 and len(images) > 0:
            first_pil = tensor_to_pil(images[0])
            tail_pil = tensor_to_pil(images[-1])
            first_pil.save(first_path, "PNG")
            tail_pil.save(tail_path, "PNG")

            if preview_for_gallery is None:
                preview_pil = create_side_by_side_preview(first_pil, tail_pil)
        else:
            first_pil = create_placeholder_card(f"{variant_name} Start: {actual_shot}", f"{vmeta.frames} frames | {vmeta.duration_seconds}s")
            tail_pil = create_placeholder_card(f"{variant_name} Tail: {actual_shot}", "Ready for Next Clip")
            first_pil.save(first_path, "PNG")
            tail_pil.save(tail_path, "PNG")

            if preview_for_gallery is None:
                preview_pil = create_side_by_side_preview(first_pil, tail_pil)

        # Video archiving
        if save_video:
            src_video = resolve_source_video_path(video_src)
            if src_video and os.path.isfile(src_video):
                ext = os.path.splitext(src_video)[1].lower()
                dest_video = os.path.join(clip_dir, f"video_{variant_name}{ext}")
                try:
                    shutil.copy2(src_video, dest_video)
                    vmeta.has_video = True
                    vmeta.video_file = f"video_{variant_name}{ext}"
                except Exception:
                    pass

            if not vmeta.has_video and images is not None:
                dest_video = os.path.join(clip_dir, f"video_{variant_name}.mp4")
                if encode_images_to_mp4(images, dest_video, fps=fps, audio_dict=audio):
                    vmeta.has_video = True
                    vmeta.video_file = f"video_{variant_name}.mp4"

            # Measure the archived video's real duration (ground truth for card display)
            if vmeta.has_video and vmeta.video_file:
                probed = probe_video_duration(os.path.join(clip_dir, vmeta.video_file))
                if probed is not None:
                    vmeta.duration_seconds = round(probed, 2)
                    vmeta.duration_source = "probed"

        meta_obj.variants[variant_name] = vmeta

    # Save combined preview
    if preview_pil is None:
        preview_pil = create_placeholder_card(f"{actual_shot}", "Dual Clip")
    preview_path = os.path.join(clip_dir, "preview.png")
    preview_pil.save(preview_path, "PNG")

    # Save meta.json
    meta_json_path = os.path.join(clip_dir, "meta.json")
    meta_dict = asdict(meta_obj)
    if workflow_mode:
        meta_dict["workflow_mode"] = workflow_mode
    with open(meta_json_path, "w", encoding="utf-8") as f:
        json.dump(meta_dict, f, indent=2, ensure_ascii=False)

    # Update project index (atomic under the per-project lock)
    if not _staging_dir:
        upsert_clip_into_index(project_name, meta_dict)

    logger.info("[Dual Clip Bin] Stored '%s' (%s) in '%s'",
                clip_id, "/".join(meta_obj.variant_labels), project_name)
    return meta_obj, clip_dir, preview_pil


@project_locked
def save_stage_asset(project_name, *, plan, context, workflow_mode, **kwargs):
    from .clip_stage import get_stage_card

    stage = plan["stage"]
    project_dir = get_project_dir(project_name)
    old = get_stage_card(project_name, plan["clip_id"], plan["revision"]) if stage == "second" else None
    target_id = old["clip_id"] if old else ""
    if target_id and (os.path.basename(target_id) != target_id or not target_id.startswith("clip_")):
        raise ValueError("不合法的片段 ID。")
    root = tempfile.mkdtemp(prefix=".h3-stage-", dir=project_dir)
    staging, backup = (os.path.join(root, name) for name in ("new", "old"))
    keep_backup = False
    try:
        if old:
            kwargs.update(shot_tag=old["shot_tag"], latent_a=None)
        elif (kwargs.get("shot_tag") or "Auto").strip().startswith("Auto") or not (kwargs.get("shot_tag") or "").strip():
            kwargs["shot_tag"] = next_shot_tag(project_name, "stage_single" if stage == "single" else "stage_dual")
        meta, _dir, _preview = save_dual_clip_asset(
            project_name=project_name, _staging_dir=staging, _target_id=target_id, **kwargs)
        required = "一采" if stage in ("first", "single") else "二采"
        if not meta.variants[required].has_latent or not meta.variants[required].has_video:
            raise ValueError(f"{required}视频或 latent 未完整保存，项目卡片没有变更。")
        card = {**asdict(meta), "workflow_mode": workflow_mode, "stage_revision": uuid4().hex,
                "stage_recipe": plan.get("recipe"), "stage_context": context}
        final = os.path.join(project_dir, meta.clip_id)
        rerun = bool(old and old["variants"].get("二采", {}).get("has_latent"))
        if old:
            # The original first-pass files are immutable. Keep their bytes and card identity.
            for entry in os.scandir(final):
                if not entry.is_file() or entry.name in ("meta.json", "preview.png") \
                        or entry.name.startswith(("latent_二采.", "first_frame_二采.", "tail_frame_二采.", "video_二采.")):
                    continue
                dst = os.path.join(staging, entry.name)
                try:
                    os.link(entry.path, dst)
                except OSError:
                    shutil.copy2(entry.path, dst)
            card = {k: v for k, v in old.items() if k not in ("locked", "stage_revision")}
            card["stage_revision"] = uuid4().hex
            card["variants"] = {**card["variants"], "二采": asdict(meta.variants["二采"])}
            # Top-level media fields may have been cached by an earlier index rebuild.
            for key in ("video_file", "has_video", "associated_video_path"):
                card.pop(key, None)
            meta.variants["一采"] = VariantMeta(**{
                k: v for k, v in old["variants"]["一采"].items() if k in VariantMeta.__dataclass_fields__
            })
        if stage in ("full", "second") and not rerun:
            card["stage_completed_at"] = datetime.now().isoformat(sep=" ", timespec="microseconds")
        atomic_write_json(os.path.join(staging, "meta.json"), card)
        if old:
            os.rename(final, backup)
        try:
            os.rename(staging, final)
            try:
                upsert_clip_into_index(project_name, card, keep_position=rerun)
            except Exception:
                os.rename(final, staging)
                raise
        except Exception:
            if old:
                keep_backup = True
                os.rename(backup, final)
                keep_backup = False
            raise
        return meta
    finally:
        if not keep_backup:
            shutil.rmtree(root, ignore_errors=True)
        else:
            logger.error("H3 could not restore the previous card; backup preserved at %s", backup)


@project_locked
def load_dual_clip_asset(project_name: str, clip_id: str, variants=VARIANTS, frames=True) -> Dict[str, Any]:
    """Loads a dual-variant clip asset from disk.
    
    Returns a dict with:
        - clip_id: str
        - meta: dict (full metadata)
        - variants: dict with keys '一采'/'二采', each containing:
            - latent: packed LATENT dict or None
            - first_frame: tensor or None
            - tail_frame: tensor or None
            - has_latent: bool
    """
    project_dir = get_project_dir(project_name)
    clip_dir = os.path.join(project_dir, clip_id)
    if not os.path.isdir(clip_dir):
        raise FileNotFoundError(f"[Dual Clip Bin] Directory not found: '{clip_dir}'")

    require_clip_kind(clip_dir, "dual")

    # Load meta
    meta_dict = {}
    meta_json_path = os.path.join(clip_dir, "meta.json")
    if os.path.isfile(meta_json_path):
        with open(meta_json_path, "r", encoding="utf-8") as f:
            meta_dict = json.load(f)

    result: Dict[str, Any] = {
        "clip_id": clip_id,
        "meta": meta_dict,
        "variants": {},
    }

    for variant_name in variants:
        latent_file = os.path.join(clip_dir, f"latent_{variant_name}.safetensors")
        vdata: Dict[str, Any] = {"has_latent": False, "latent": None, "first_frame": None, "tail_frame": None}

        if os.path.isfile(latent_file):
            if st_load is not None:
                tensors = st_load(latent_file, device="cpu")
            else:
                tensors = torch.load(latent_file, map_location="cpu")

            video = tensors.get("video")
            audio = tensors.get("audio")
            if video is not None:
                vdata["has_latent"] = True
                vdata["latent"] = pack_av_latent(video, audio)

        # Keyframes belong to the same Saver format as the latent.
        first_path = os.path.join(clip_dir, f"first_frame_{variant_name}.png")
        tail_path = os.path.join(clip_dir, f"tail_frame_{variant_name}.png")

        if frames and os.path.isfile(first_path):
            vdata["first_frame"] = pil_to_tensor(Image.open(first_path))
        if frames and os.path.isfile(tail_path):
            vdata["tail_frame"] = pil_to_tensor(Image.open(tail_path))

        result["variants"][variant_name] = vdata

    return result


def create_dual_placeholder_card(title: str, subtitle: str, variants: List[str]) -> Image.Image:
    """Creates a placeholder card showing which variants are available."""
    img = create_placeholder_card(title, subtitle)
    draw = ImageDraw.Draw(img)
    y = 160
    for v in variants:
        color = (147, 197, 253) if v == "一采" else (167, 243, 208)
        draw.text((30, y), f"✓ {v}", fill=color)
        y += 25
    return img
