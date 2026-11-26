"""Restore the previous clip's original video tokens after final sampling."""

import logging
import math

import torch
from comfy_api.latest import io

from .nodes import _steps_for_frames
from .local_color import compensate_new_content


_LOG = logging.getLogger("h3_motion_context")
WINDOWS = (5, 22, 39, 56)


def video_stream(latent, label):
    if not isinstance(latent, dict) or "samples" not in latent:
        raise ValueError(f"H3 Overlap Restore: {label} must be a LATENT.")
    samples = latent["samples"]
    if isinstance(samples, torch.Tensor):
        parts = [samples]
    elif isinstance(samples, (list, tuple)):
        parts = list(samples)
    elif getattr(samples, "is_nested", False) and hasattr(samples, "unbind"):
        parts = list(samples.unbind())
    else:
        raise ValueError(f"H3 Overlap Restore: unsupported {label} samples container.")
    if not parts or not isinstance(parts[0], torch.Tensor):
        raise ValueError(f"H3 Overlap Restore: {label} has no video tensor.")
    raw = parts[0]
    video = raw.unsqueeze(0) if raw.ndim == 4 else raw
    if video.ndim != 5 or video.shape[1] != 24:
        raise ValueError(
            f"H3 Overlap Restore: {label} must contain H3 video [B,24,T,H,W]; "
            f"got {tuple(raw.shape)}."
        )
    if not video.is_floating_point():
        raise ValueError(f"H3 Overlap Restore: {label} video must be floating point.")
    return video, raw.ndim, parts


def restore_overlap(samples, trim_frames, enabled=True, context_latent=None,
                    color_compensation=False, color_strength=0.25, color_fade_frames=22,
                    color_follow_overlap=False):
    """Copy only an aligned parent suffix; never mutate either input."""
    if not enabled or trim_frames == 0:
        return samples
    if color_compensation:
        if color_follow_overlap:
            color_fade_frames = trim_frames
        if not math.isfinite(color_strength) or not 0 <= color_strength <= 1:
            raise ValueError("H3 Overlap Restore: color_strength must be finite and in [0, 1].")
        if (isinstance(color_fade_frames, bool)
                or not isinstance(color_fade_frames, int) or not 0 <= color_fade_frames <= 120):
            raise ValueError("H3 Overlap Restore: color_fade_frames must be an integer in [0, 120].")
    if trim_frames not in WINDOWS:
        raise ValueError(
            "H3 Overlap Restore: trim_frames must be 0, 5, 22, 39 or 56. "
            "Connect Motion Context.trim_frames; do not use audio context length."
        )
    if context_latent is None:
        raise ValueError(
            "H3 Overlap Restore: trim_frames is nonzero but context_latent is empty. "
            "Connect the previous clip's original pass-2 latent."
        )
    current, raw_ndim, parts = video_stream(samples, "samples")
    previous, _, _ = video_stream(context_latent, "context_latent")
    steps = _steps_for_frames(trim_frames)
    if previous.shape[2] < steps or current.shape[2] <= steps:
        raise ValueError(
            "H3 Overlap Restore: parent must cover the overlap and current clip "
            "must contain new content after it."
        )
    start = previous.shape[2] - steps
    if start % 5:
        raise ValueError(
            f"H3 Overlap Restore: parent tail starts at temporal cycle {start % 5}, "
            "expected 0. Refusing a shifted overlap."
        )
    if any(previous.shape[d] != current.shape[d] for d in (0, 1, 3, 4)):
        raise ValueError(
            "H3 Overlap Restore: batch, channels and spatial resolution must match. "
            "Use the previous pass-2 latent, not pass-1 or an upscaled substitute."
        )
    if previous.dtype != current.dtype:
        raise ValueError(
            f"H3 Overlap Restore: dtype mismatch ({previous.dtype}, {current.dtype}). "
            "Use matching latent precision; exact restoration does not cast tokens."
        )
    video = current.clone()
    parent_tail = previous[:, :, start:].to(device=current.device)
    video[:, :, :steps].copy_(parent_tail)
    if color_compensation:
        report = compensate_new_content(
            video, parent_tail, current[:, :, :steps], steps,
            color_strength, color_fade_frames,
        )
        _LOG.info("H3 Overlap Restore: experimental local color %s", report)
    if raw_ndim == 4:
        video = video.squeeze(0)
    # Keep the current audio and all other streams by reference, in their container.
    original_container = samples["samples"]
    if isinstance(original_container, torch.Tensor):
        packed = video
    else:
        parts[0] = video
        if isinstance(original_container, list):
            packed = parts
        elif isinstance(original_container, tuple):
            packed = tuple(parts)
        else:
            packed = type(original_container)(parts)
    result = dict(samples)
    result["samples"] = packed
    _LOG.info(
        "H3 Overlap Restore: restored %d video steps (%d frames) from parent "
        "tail; experimental local color enabled=%s.",
        steps, trim_frames, color_compensation,
    )
    return result


class MiniMaxH3OverlapRestoreClipStream(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxH3OverlapRestoreClipStream",
            display_name="H3 Overlap Restore / 原始重叠恢复 (ClipStream)",
            category="latent/minimax",
            description=(
                "最终采样后恢复上一段原始视频重叠 token，接在解码和 latent 保存之前。"
                "可选实验性局部颜色补偿，通过重叠区估计逐通道偏移，"
                "在接点后的短窗口内衰减施加。检测值和修正量记录到控制台。"
            ),
            inputs=[
                io.Latent.Input("samples", tooltip="当前段最终采样输出，尚未解码或裁切。"),
                io.Int.Input(
                    "trim_frames", default=0, min=0, max=56, force_input=True,
                    tooltip="连接本段 Motion Context 的 trim_frames；首段 0 自动透传。",
                ),
                io.Boolean.Input("enabled", default=True, tooltip="关闭后原样透传，便于对比。"),
                io.Latent.Input(
                    "context_latent", optional=True,
                    tooltip="上一段同采样阶段、同分辨率的原始 latent。"
                            "若使用上下文加噪，必须从加噪之前分支接入这里。",
                ),
                io.Boolean.Input(
                    "color_compensation", default=False, optional=True,
                    display_name="局部颜色补偿（实验）",
                    tooltip="从嫁接前的新旧重叠区估计稳定偏移，仅补偿接点后的短窗口。"
                            "需用解码画面验证；旧工作流默认关闭。",
                ),
                io.Float.Input(
                    "color_strength", default=0.25, min=0, max=1, step=0.05, optional=True,
                    display_name="补偿强度",
                    tooltip="逐通道偏移经置信度与幅度限制后乘此强度。0 只恢复重叠。",
                ),
                io.Int.Input(
                    "color_fade_frames", default=22, min=0, max=120, optional=True,
                    display_name="手动衰减帧数",
                    tooltip="接点后按余弦曲线衰减。仅覆盖窗口内完整 latent 时间步，"
                            "实际范围向下对齐；0 只恢复重叠。这不是空间分区调色。",
                ),
                io.Boolean.Input(
                    "color_follow_overlap", default=False, optional=True,
                    display_name="补偿衰减范围", label_on="跟随重叠", label_off="手动",
                    tooltip="使用对应采样阶段 Motion Context 实际输出的重叠帧数，无需额外接线。",
                ),
            ],
            outputs=[io.Latent.Output(display_name="latent")],
        )

    @classmethod
    def execute(cls, samples, trim_frames, enabled=True, context_latent=None,
                color_compensation=False, color_strength=0.25, color_fade_frames=22,
                color_follow_overlap=False):
        return io.NodeOutput(restore_overlap(
            samples, trim_frames, enabled, context_latent,
            color_compensation, color_strength, color_fade_frames, color_follow_overlap,
        ))


NODE_LIST = [MiniMaxH3OverlapRestoreClipStream]
NODE_CLASS_MAPPINGS = {"MiniMaxH3OverlapRestoreClipStream": MiniMaxH3OverlapRestoreClipStream}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3OverlapRestoreClipStream": "H3 Overlap Restore / 原始重叠恢复 (ClipStream)",
}
