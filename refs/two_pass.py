"""Two-pass helpers: the sigma schedule for both passes and the pass-2 latent preparation.

refine_sigmas is ported from H3 Sigma Refiner (ComfyUI-YCNodes-MiniMax-H3, author 亦诚 / yc,
MIT). reconcile_two_pass is ported from MiniMaxH3TwoPassLatentReconcileT8Advanced
(comfyui-minimax-h3-audio-T8, GPL-3.0-or-later). The algorithms are kept as they are; only the
packaging changed. See toolbox/ATTRIBUTION.md.

No ComfyUI imports at module level, so the pure parts are testable on their own.
"""
from __future__ import annotations

import math

import torch

SPACINGS = ("cosine", "linear", "exponential")
AUDIO_POLICIES = ("auto", "first_pass", "highres_template")
SECOND_PASS_AUDIO_SOURCES = ("legacy_policy", "first_pass", "highres_template")
PIXELS_PER_H3_LATENT = 16


# ---------- sigmas ----------
def refine_sigmas(sigmas, extra_steps, start_at_sigma, end_at_sigma, spacing):
    """Add extra_steps in the low-noise tail (H3 Sigma Refiner, unchanged)."""
    if extra_steps <= 0:
        return sigmas
    sigmas_cpu = sigmas.detach().cpu()
    idx = -1
    for i, s in enumerate(sigmas_cpu):
        if s <= start_at_sigma:
            idx = i
            break
    if idx == -1 or idx >= len(sigmas_cpu) - 1:
        return sigmas
    unmodified_head = sigmas_cpu[:idx]
    a = sigmas_cpu[idx].item()
    b = max(end_at_sigma, sigmas_cpu[-1].item())
    new_tail_len = len(sigmas_cpu) - idx + extra_steps
    t = torch.linspace(0.0, 1.0, steps=new_tail_len)
    if spacing == "cosine":
        factor = (1.0 - torch.cos(t * math.pi)) / 2.0
    elif spacing == "exponential":
        alpha = 3.0
        factor = (torch.exp(t * alpha) - 1.0) / (math.exp(alpha) - 1.0)
    else:
        factor = t
    new_tail = a + (b - a) * factor
    if sigmas_cpu[-1].item() == 0.0 and b > 0.0:
        new_tail = torch.cat([new_tail, torch.tensor([0.0])])
    return torch.cat([unmodified_head, new_tail]).to(device=sigmas.device, dtype=sigmas.dtype)


def split_two_pass(sigmas, first_steps):
    """SplitSigmas at the end of pass 1: (high, low), sharing the boundary sigma."""
    return sigmas[:first_steps + 1], sigmas[first_steps:]


# ---------- pass-2 latent ----------
def nested_parts(value, field_name):
    if not getattr(value, "is_nested", False):
        raise ValueError(f"{field_name} 不是 MiniMax H3 的音画 latent（需要视频 + 音频两部分）。")
    parts = tuple(value.unbind())
    if len(parts) != 2:
        raise ValueError(f"{field_name} 应该只有视频和音频两部分，实际有 {len(parts)} 部分。")
    video, audio = parts
    if not isinstance(video, torch.Tensor) or video.ndim != 5:
        raise ValueError(f"{field_name} 的视频部分形状不对：{getattr(video, 'shape', None)}，应为 [B,C,T,H,W]。")
    if not isinstance(audio, torch.Tensor) or audio.ndim != 4:
        raise ValueError(f"{field_name} 的音频部分形状不对：{getattr(audio, 'shape', None)}，应为 [B,C,F,T]。")
    return video, audio


def clone_conditioning(conditioning):
    if not isinstance(conditioning, list):
        raise ValueError("positive 必须是 ComfyUI 的 CONDITIONING。")
    return [[item[0], item[1].copy()] for item in conditioning]


def check_conditioning_size(positive, target_h, target_w):
    """Every keyframe / reference latent in pass-2 conditioning must be rebuilt at pass-2 size."""
    keyframe_count = ref_count = 0
    for entry_index, item in enumerate(positive):
        if not isinstance(item, (list, tuple)) or len(item) != 2 or not isinstance(item[1], dict):
            raise ValueError(f"positive[{entry_index}] 不是有效的条件。")
        metadata = item[1]
        for keyframe_index, keyframe in enumerate(metadata.get("minimax_keyframes") or []):
            keyframe_count += 1
            latent = keyframe.get("latent")
            if latent is not None:
                if not isinstance(latent, torch.Tensor) or latent.ndim != 5:
                    raise ValueError("MiniMax H3 关键帧 latent 必须是 5 维。")
                if tuple(latent.shape[-2:]) != (target_h, target_w):
                    raise ValueError(
                        f"二采的条件不是按二采分辨率重新生成的：关键帧 {keyframe_index} 是 "
                        f"{latent.shape[-1] * 16}x{latent.shape[-2] * 16}，二采是 {target_w * 16}x{target_h * 16}。"
                        "请把二采的 positive 接到二采那一路（二采 Ref2V / 二采 Motion Context），不要接一采的。")
        for ref_index, ref in enumerate(metadata.get("minimax_refs") or []):
            ref_count += 1
            latent = ref.get("latent")
            if ref.get("kind") in {"image", "video", "video_audio"} and latent is not None:
                if not isinstance(latent, torch.Tensor) or latent.ndim != 5:
                    raise ValueError(f"参考素材 {ref_index} 的 latent 必须是 5 维。")
                declared = (int(ref.get("latent_h", -1)), int(ref.get("latent_w", -1)))
                actual = tuple(int(v) for v in latent.shape[-2:])
                if declared != actual:
                    raise ValueError(f"参考素材 {ref_index} 的尺寸记录与实际 latent 不符：记录 {declared}，实际 {actual}。")
    return {"keyframes": keyframe_count, "refs": ref_count}


def reconcile_two_pass(learned_latent, highres_template, positive, audio_policy="auto",
                       second_pass_audio_source="legacy_policy", second_pass_audio_strength=0.0):
    """Pass-1 values on the pass-2 template (T8 reconcile, same behaviour).

    Returns (latent, positive, report dict).
    """
    import comfy.nested_tensor

    if audio_policy not in AUDIO_POLICIES:
        raise ValueError(f"未知的 audio_policy：{audio_policy!r}")
    if second_pass_audio_source not in SECOND_PASS_AUDIO_SOURCES:
        raise ValueError(f"未知的 second_pass_audio_source：{second_pass_audio_source!r}")
    second_pass_audio_strength = float(second_pass_audio_strength)
    if not math.isfinite(second_pass_audio_strength) or not 0.0 <= second_pass_audio_strength <= 1.0:
        raise ValueError("second_pass_audio_strength 必须在 0 到 1 之间。")
    learned_video, learned_audio = nested_parts(learned_latent["samples"], "放大后的一采 latent")
    template_video, template_audio = nested_parts(highres_template["samples"], "二采模板 latent")
    if tuple(learned_video.shape) != tuple(template_video.shape):
        lw, lh = learned_video.shape[-1] * PIXELS_PER_H3_LATENT, learned_video.shape[-2] * PIXELS_PER_H3_LATENT
        tw, th = template_video.shape[-1] * PIXELS_PER_H3_LATENT, template_video.shape[-2] * PIXELS_PER_H3_LATENT
        raise ValueError(
            f"放大后的一采是 {lw}x{lh}（{tuple(learned_video.shape)}），二采模板是 {tw}x{th}"
            f"（{tuple(template_video.shape)}），两者必须完全相同。二采 Ref2V 请接「H3 生成设置」并选“二采”。")
    if tuple(learned_audio.shape) != tuple(template_audio.shape):
        raise ValueError(f"一采与二采模板的音频长度不同：一采 {tuple(learned_audio.shape)}，模板 {tuple(template_audio.shape)}。"
                         "两采的 length 必须相同。")
    if not torch.isfinite(learned_video).all() or not torch.isfinite(learned_audio).all():
        raise ValueError("一采 latent 里有 NaN 或 Inf，无法继续二采。")
    positive_out = clone_conditioning(positive)
    counts = check_conditioning_size(positive_out, int(learned_video.shape[-2]), int(learned_video.shape[-1]))

    template_mask = highres_template.get("noise_mask")
    locked_or_partial_audio = False
    template_video_mask = template_audio_mask = None
    if template_mask is not None:
        template_video_mask, template_audio_mask = nested_parts(template_mask, "二采模板的 noise_mask")
        if tuple(template_video_mask.shape) != tuple(template_video.shape):
            raise ValueError("二采模板视频遮罩的形状不对。")
        if tuple(template_audio_mask.shape) != tuple(template_audio.shape):
            raise ValueError("二采模板音频遮罩的形状不对。")
        locked_or_partial_audio = bool(torch.any(template_audio_mask < 1.0).item())
    if second_pass_audio_source == "legacy_policy":
        use_template_audio = audio_policy == "highres_template" or (audio_policy == "auto" and locked_or_partial_audio)
    else:
        use_template_audio = second_pass_audio_source == "highres_template"
    selected_audio = template_audio if use_template_audio else learned_audio
    audio_source = "highres_template" if use_template_audio else "first_pass"

    output = highres_template.copy()
    output["samples"] = comfy.nested_tensor.NestedTensor((learned_video, selected_audio))
    video_mask_source = "none"
    if second_pass_audio_source == "legacy_policy" and template_mask is not None:
        output["noise_mask"] = comfy.nested_tensor.NestedTensor((template_video_mask, template_audio_mask))
        video_mask_source = "highres_template"
    elif second_pass_audio_source != "legacy_policy":
        if template_video_mask is None:
            template_video_mask = torch.ones_like(template_video)
            video_mask_source = "generated_all_ones"
        else:
            video_mask_source = "highres_template"
        template_audio_mask = torch.full_like(selected_audio, second_pass_audio_strength)
        output["noise_mask"] = comfy.nested_tensor.NestedTensor((template_video_mask, template_audio_mask))
    report = {"video_shape": list(learned_video.shape), "audio_shape": list(selected_audio.shape),
              "audio_source": audio_source, "video_mask_source": video_mask_source,
              "template_has_mask": template_mask is not None, "audio_locked_or_partial": locked_or_partial_audio,
              "conditioning": counts}
    return output, positive_out, report
