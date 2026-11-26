"""「H3 片段选择 v2」and「H3 片段保存 v2」.

One Picker / Saver pair for both single-pass and two-pass workflows. Cards use the dual
folder layout, so the original Dual Picker and the Long Builder read them unchanged;
original single-Saver cards are read as 一采-only cards. The original four nodes stay
registered for old workflows.
"""
from __future__ import annotations

import logging
import json
import os
import shutil
import subprocess
import tempfile
from typing import Any, Dict, List, Optional

import torch
from comfy_api.latest import io
from PIL import Image

from ._shared import pack_av_latent
from .clip_bin_manager import (
    clip_asset_kind,
    create_placeholder_card,
    filter_clips_by_kind,
    get_project_dir,
    list_projects,
    load_clip_asset,
    load_project_index,
    pil_to_tensor,
    resolve_source_video_path,
    stage_card_category,
)
from .dual_manager import load_dual_clip_asset, save_dual_clip_asset, save_stage_asset
from .clip_stage import ClipStageError, check_second_size, get_stage_card, stage_parent
from .v2_core import (
    AUDIO_LENGTH_MAX,
    CONTEXT_LENGTHS,
    DEFAULT_AUDIO_LENGTH,
    DEFAULT_CONTEXT_LENGTH,
    LATEST,
    MODE_CONTINUE,
    MODE_NEW,
    MODES,
    FLOW_DUAL,
    FLOW_SINGLE,
    FLOWS,
    check_link,
    make_link,
    normalize_context,
    normalize_mode,
    normalize_passes,
    picker_status,
    resolve_target,
    saver_status,
    shot_label,
    video_variant,
)

logger = logging.getLogger("minimax_clip_bin_v2")
ClipLink = io.Custom("H3_CLIP_LINK")


def _cards(project: str, selection_kind: str = "v2") -> List[Dict[str, Any]]:
    """Newest first; dual cards plus original single-Saver cards (read as 一采 only)."""
    index = load_project_index(project)
    project_dir = get_project_dir(project)
    out = []
    for clip in filter_clips_by_kind(project, index.get("clips", []), selection_kind):
        folder = os.path.join(project_dir, clip["clip_id"])
        if selection_kind == "stage_dual" and stage_card_category(folder, clip) != "dual":
            continue
        out.append({**clip, "_kind": clip_asset_kind(folder)})
    return out


def _load(project: str, clip: Dict[str, Any]):
    """(latent_一采, latent_二采, tail frame tensor or None) for one card."""
    if clip.get("_kind") == "single":
        video, audio, tail, _first, _meta = load_clip_asset(project, clip["clip_id"])
        return pack_av_latent(video, audio), None, tail
    data = load_dual_clip_asset(project, clip["clip_id"])
    first = data["variants"].get("一采", {})
    second = data["variants"].get("二采", {})
    tail = second.get("tail_frame") if second.get("tail_frame") is not None else first.get("tail_frame")
    return first.get("latent"), second.get("latent"), tail


class H3ClipPickerV2(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        projects = list_projects()
        return io.Schema(
            node_id="MiniMaxClipPickerV2",
            display_name="H3 片段选择 v2",
            category="MiniMaxH3/ClipStream",
            description="从项目素材库里选上一段作为接续来源。一采、二采工作流都能用；只跑一采时二采接续不用接。",
            inputs=[
                io.String.Input("project_name", default=projects[0] if projects else "Default_Project",
                                display_name="项目"),
                io.Combo.Input("mode", options=MODES, default=MODE_CONTINUE, display_name="模式",
                               tooltip="接续前段：接着选中的片段（默认最新）往下生成；库是空的时自动按全新段落。\n"
                                       "全新段落：不接任何片段，从头生成。"),
                io.String.Input("clip_selection", default=LATEST, display_name="接续片段",
                                tooltip="latest = 跟随最新（每次接最新的一段）；其他值 = 固定接卡片墙里选中的那一段。"),
                io.Combo.Input("passes", options=FLOWS, default=FLOW_DUAL, display_name="工作流",
                               tooltip="按你用的工作流选：\n"
                                       "双采：一采 + 二采放大的双采样工作流（如万物皆可接续），两个接续口都输出，保存一采和二采。\n"
                                       "单采：只采样一次的工作流，只用一采接续，只保存一采。"),
                io.Combo.Input("context_length", options=CONTEXT_LENGTHS, default=DEFAULT_CONTEXT_LENGTH, optional=True,
                               display_name="重叠帧",
                               tooltip="从上一段结尾带过来多少帧画面，钉在这一段开头，解码后会裁掉。\n"
                                       "接续信息连到 Motion Context 后，所有 Motion Context 都用这里的值，不用再分别设置。\n"
                                       "5 勉强连贯，22 基本无缝（推荐），39 / 56 动作更稳但每段多裁 1.6 / 2.3 秒。"),
                io.Boolean.Input("enable_audio_context", default=False, optional=True, display_name="声音接续",
                                 tooltip="打开后把上一段结尾的声音也带过来，让音乐、环境声接得上。"),
                io.Int.Input("audio_context_length", default=DEFAULT_AUDIO_LENGTH, min=0, max=AUDIO_LENGTH_MAX, optional=True,
                             display_name="声音帧",
                             tooltip="声音接续带过来多少帧（按 24 fps 计），只在声音接续打开时有效。0 = 跟重叠帧一样。\n"
                                     "越长音乐越连贯，但每个接口的声音会更闷一点。3 的倍数正好落在音频网格上。"),
            ],
            outputs=[
                io.Latent.Output(display_name="一采接续",
                                 tooltip="接一采 Motion Context 的 context_latent。全新段落时为空。"),
                io.Latent.Output(display_name="二采接续",
                                 tooltip="接二采 Motion Context 的 context_latent。单采工作流不用接。"),
                ClipLink.Output(display_name="接续信息",
                                tooltip="接「H3 片段保存 v2」：保存时自动归到同一个项目并记录接自哪一段。\n"
                                        "也接每个 Motion Context 的「接续设置」：重叠帧和声音接续统一用这里的设置。"),
                io.Image.Output(display_name="尾帧", tooltip="上一段的最后一帧；全新段落时为占位图。"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")  # reads mutable disk state every run

    @classmethod
    def execute(cls, project_name="Default_Project", mode=MODE_CONTINUE, clip_selection=LATEST,
                passes=FLOW_DUAL, context_length=DEFAULT_CONTEXT_LENGTH, enable_audio_context=False,
                audio_context_length=DEFAULT_AUDIO_LENGTH) -> io.NodeOutput:
        return cls._pick(project_name, mode, clip_selection, passes, context_length, enable_audio_context,
                         audio_context_length)

    @classmethod
    def _pick(cls, project_name, mode, clip_selection, passes, context_length, enable_audio_context,
              audio_context_length, selection_kind="v2", second_size=None):
        project = (project_name or "Default_Project").strip()
        mode = normalize_mode(mode)
        passes = normalize_passes(passes)
        context = normalize_context(context_length, enable_audio_context, audio_context_length)
        target = None
        empty_fallback = False
        if mode == MODE_CONTINUE:
            cards = _cards(project, selection_kind)
            if not cards and selection_kind != "v2" and clip_selection not in ("", LATEST):
                raise ValueError("固定的接续片段不在当前工作流的片段库。请重新选择，或打开「跟随最新」。")
            target = resolve_target(cards, clip_selection)
            empty_fallback = target is None
        if second_size:
            check_second_size(target, second_size)
        if target is None:
            status = picker_status(project, mode, None, empty_fallback, False, passes)
            placeholder = pil_to_tensor(create_placeholder_card("全新段落", project))
            link = make_link(project, MODE_NEW, None, status, passes, context)
            return io.NodeOutput(None, None, link, placeholder,
                                 ui={"h3_clip_v2": [{"status": status, "target": "", "empty": empty_fallback}]})
        latent_a, latent_b, tail = _load(project, target)
        if passes == FLOW_SINGLE:
            latent_b = None
        status = picker_status(project, mode, target, False, latent_b is None, passes)
        if tail is None:
            tail = pil_to_tensor(create_placeholder_card(shot_label(target), "尾帧"))
        link = make_link(project, MODE_CONTINUE, target, status, passes, context)
        logger.info("[Clip Picker v2] %s", status)
        return io.NodeOutput(latent_a, latent_b, link, tail,
                             ui={"h3_clip_v2": [{"status": status, "target": target["clip_id"],
                                                 "missing_second": passes == FLOW_DUAL and latent_b is None}]})


def _video_frames(path: str):
    """First and last frame of a video file as PIL images, via ffmpeg. (None, None) on failure."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not path or not os.path.isfile(path):
        return None, None
    folder = tempfile.mkdtemp(prefix="h3_clip_v2_")
    try:
        first = os.path.join(folder, "first.png")
        last = os.path.join(folder, "last.png")
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", path, "-frames:v", "1", first],
                       check=False, timeout=60, **flags)
        subprocess.run([ffmpeg, "-v", "error", "-y", "-sseof", "-0.5", "-i", path, "-update", "1", last],
                       check=False, timeout=60, **flags)
        images = []
        for file in (first, last):
            images.append(Image.open(file).convert("RGB").copy() if os.path.isfile(file) else None)
        return images[0], images[1] or images[0]
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def _frames_tensor(first, last):
    if first is None:
        return None
    a = pil_to_tensor(first)
    b = pil_to_tensor(last.resize(first.size) if last is not None and last.size != first.size else (last or first))
    return torch.cat([a, b], dim=0)


class H3ClipSaverV2(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="MiniMaxClipSaverV2",
            display_name="H3 片段保存 v2",
            category="MiniMaxH3/ClipStream",
            is_output_node=True,
            description="把这一段存进项目素材库。接上片段选择 v2 的接续信息后，项目和接续来源自动跟随。",
            inputs=[
                ClipLink.Input("link", display_name="接续信息",
                               tooltip="接「H3 片段选择 v2」的接续信息。"),
                io.Latent.Input("latent_1", display_name="一采 latent",
                                tooltip="一采采样器的输出（下一段接续要用）。"),
                io.Latent.Input("latent_2", optional=True, display_name="二采 latent",
                                tooltip="二采采样器的输出。片段选择 v2 的工作流设为「单采」时不用接，接了也不保存。"),
                io.AnyType.Input("video", optional=True, display_name="成片视频",
                                 tooltip="接 Video Combine 的 Filenames（或视频路径）。首尾帧和封面从视频里取；"
                                         "双采工作流里算二采的视频，单采工作流里算一采的视频。"),
                io.Image.Input("images", optional=True, display_name="画面",
                               tooltip="没接成片视频时使用：解码后的画面，会和音频一起编码成视频存档。"),
                io.Audio.Input("audio", optional=True, display_name="音频",
                               tooltip="和「画面」一起使用。"),
                io.String.Input("prompt", optional=True, default="", force_input=True, display_name="提示词",
                                tooltip="这一段用的提示词，存进卡片以便回顾。"),
                io.String.Input("shot_tag", default="Auto", display_name="镜头名",
                                tooltip="Auto = 自动编号（Shot 1、Shot 2…）；也可以自己写，比如「男主回眸」。"),
            ],
            outputs=[io.String.Output(display_name="片段 ID")],
        )

    @classmethod
    def execute(cls, link, latent_1, latent_2=None, video=None, images=None, audio=None, prompt="",
                shot_tag="Auto") -> io.NodeOutput:
        link = check_link(link)
        if latent_1 is None:
            raise ValueError("H3 片段保存 v2：没有收到一采 latent。")
        project = str(link["project"]).strip()
        passes = normalize_passes(link.get("passes"))
        plan = link.get("stage_plan")
        stage = plan["stage"] if plan else ""
        if passes == FLOW_SINGLE or stage == "first":
            latent_2 = None
        elif latent_2 is None:
            raise ValueError("H3 片段保存 v2：片段选择 v2 的工作流是「双采」，但没有接二采 latent。"
                             "只采样一次的工作流请把片段选择 v2 的工作流切到「单采」。")
        variant = "一采" if stage == "first" else video_variant(passes)
        path = resolve_source_video_path(video) if video not in (None, "") else None
        frames = _frames_tensor(*_video_frames(path)) if path else None
        kwargs = {"video_file_name_a": "", "video_file_name_b": "", "images_a": None, "images_b": None,
                  "audio_a": None, "audio_b": None}
        key = "b" if variant == "二采" else "a"
        if path:
            kwargs[f"video_file_name_{key}"] = path
            kwargs[f"images_{key}"] = frames  # keyframes and preview; the file itself is copied
        elif images is not None:
            kwargs[f"images_{key}"] = images
            kwargs[f"audio_{key}"] = audio
        tag = (shot_tag or "").strip()
        kwargs.update(
            latent_a=latent_1, latent_b=latent_2, project_name=project,
            shot_tag="Auto" if not tag or tag.lower().startswith("auto") else tag,
            prompt=prompt if isinstance(prompt, str) else str(prompt or ""),
            parent_clip_id=link.get("parent_clip_id") or "[INITIAL]",
            save_video=True)
        if plan:
            meta = save_stage_asset(plan=plan, context=link["context"], workflow_mode=passes, **kwargs)
        else:
            meta, _clip_dir, _preview = save_dual_clip_asset(workflow_mode=passes, **kwargs)
        status = (f"{meta.shot_tag} 已保存为一采草稿" if stage == "first" else
                  f"{meta.shot_tag} 已完成二采" if stage == "second" else
                  saver_status(meta.shot_tag, link, meta.variant_labels))
        logger.info("[Clip Saver v2] %s in '%s'", status, project)
        return io.NodeOutput(meta.clip_id, ui={"h3_clip_v2": [{"status": status, "clip_id": meta.clip_id,
                                                              "project": project, "stage": stage}]})


class H3ClipStagePicker(H3ClipPickerV2):
    @classmethod
    def define_schema(cls):
        schema = super().define_schema()
        schema.node_id = "MiniMaxClipStagePicker"
        schema.description = "为抽卡工作流选择接续片段，或用已保存的一采草稿只跑二采。"
        schema.inputs.extend([
            io.Boolean.Input("draft_only", default=False, optional=True, display_name="只跑一采"),
            io.String.Input("refine_clip", default="", optional=True, display_name="二采卡片"),
            io.String.Input("refine_revision", default="", optional=True, display_name="二采卡片版本"),
            io.String.Input("stage_plan", default="", optional=True, display_name="抽卡执行计划"),
        ])
        schema.outputs.append(io.Latent.Output(display_name="已存一采", tooltip="仅二采时由抽卡工作流自动使用。"))
        return schema

    @classmethod
    def execute(cls, project_name="Default_Project", mode=MODE_CONTINUE, clip_selection=LATEST,
                passes=FLOW_DUAL, context_length=DEFAULT_CONTEXT_LENGTH, enable_audio_context=False,
                audio_context_length=DEFAULT_AUDIO_LENGTH, draft_only=False, refine_clip="", refine_revision="",
                stage_plan=""):
        if not stage_plan:
            raise ValueError("抽卡调度未启用，任务已停止。请重启运行当前版本 Toolbox 的 ComfyUI。")
        plan = json.loads(stage_plan)
        project = (project_name or "Default_Project").strip()
        if plan["stage"] == "second":
            card = get_stage_card(project, plan["clip_id"], plan["revision"])
            parent = stage_parent(project, card)
            if plan.get("second_size"):
                check_second_size(parent, plan["second_size"])
            prior = _load(project, {**parent, "_kind": "dual"}) if parent else (None, None, None)
            if parent and prior[1] is None:
                raise ValueError("上一段的二采 latent 不可用，任务已停止。")
            data = load_dual_clip_asset(project, card["clip_id"], variants=("一采",), frames=False)
            latent = data["variants"]["一采"]["latent"]
            if latent is None:
                raise ValueError("这张卡的一采 latent 不可用。")
            context = card.get("stage_context") or normalize_context()
            status = f"仅跑二采 · {shot_label(card)}"
            link = make_link(project, MODE_CONTINUE if parent else MODE_NEW, parent, status, FLOW_DUAL, context)
            link["stage_plan"] = plan
            tail = prior[2] if prior[2] is not None else pil_to_tensor(create_placeholder_card("仅跑二采", project))
            return io.NodeOutput(prior[0], prior[1], link, tail, latent,
                                 ui={"h3_clip_v2": [{"status": status, "stage": "second"}]})
        kind = "stage_single" if plan["stage"] == "single" else "stage_dual"
        result = cls._pick(project, mode, clip_selection, passes, context_length, enable_audio_context,
                           audio_context_length, kind, plan.get("second_size"))
        a, b, link, tail = result.args
        link["stage_plan"] = plan
        return io.NodeOutput(a, b, link, tail, None, ui=result.ui)


class H3ClipStageSaver(H3ClipSaverV2):
    @classmethod
    def define_schema(cls):
        schema = super().define_schema()
        schema.node_id = "MiniMaxClipStageSaver"
        schema.inputs.append(io.AnyType.Input("draft_video", optional=True, display_name="一采预览视频"))
        return schema

    @classmethod
    def execute(cls, link, draft_video=None, **kwargs):
        if not check_link(link).get("stage_plan"):
            raise ValueError("这个保存节点必须配合新版抽卡工作流。")
        return super().execute(link, **kwargs)


NODE_LIST = [H3ClipPickerV2, H3ClipSaverV2]
STAGE_NODES = [H3ClipStagePicker, H3ClipStageSaver, ClipStageError]
