"""「H3 参考素材」and「H3 参考生成视频（素材包）」.

The hub decodes every card once and emits a single H3_REFS bundle. The Ref2V node
unpacks that bundle into the native MiniMaxH3ReferenceToVideo, so the H3 order and
the <Picture i> / <Video k> / <Audio j> numbering stay exactly the native ones.

Decoding reuses the Long Video Manager helpers. Imports are lazy so a missing helper
or a ComfyUI without MiniMax H3 only fails these nodes, never the whole extension.
"""
from __future__ import annotations

import gc
import hashlib
import json
import logging
import os
import re

from comfy_api.latest import io

from .core import (MAX_AUDIOS, MAX_IMAGES, MAX_VIDEOS, ORIENTATIONS, RATIO_NAMES, assign_labels,
                   build_settings, check_settings, h3_canvas_long_side, library_keys,
                   manifest_text, pad_to_17n5, parse_document, plan_length, refs_payload)

NODE_ID = "AmiaomiaoH3_ReferenceHub"
REF2V_NODE_ID = "AmiaomiaoH3_ReferenceToVideo"
SETTINGS_NODE_ID = "AmiaomiaoH3_GenerationSettings"
PROMPT_NODE_ID = "AmiaomiaoH3_Prompt"
H3Refs = io.Custom("H3_REFS")
H3Settings = io.Custom("H3_GENERATION_SETTINGS")
logger = logging.getLogger(__name__)

RESAMPLE_OPTIONS = ["Lanczos", "Bicubic", "Bilinear", "Nearest"]
EMPTY_DOC = json.dumps({"version": 1, "images": [], "audios": [], "videos": []})


def _helpers():
    from ..long_video.comfyui import ref_nodes, segment_store, uploaded_video_store, video_decode
    from ..long_video.core import ref_media
    return ref_nodes, segment_store, uploaded_video_store, video_decode, ref_media


def _silent(frames):
    import torch
    seconds = max(frames, 1) / 24.0
    return {"waveform": torch.zeros(1, 1, max(1, int(seconds * 44100))), "sample_rate": 44100}


def _check_key(card, record, label):
    if card["key"] and card["key"] not in library_keys(card["source"], record):
        raise ValueError(
            f"{label}：素材库「{card['project']}」里的编号 {card['segment_id']} 已经换成了别的视频"
            "（删除或排序后编号会顺延），请在视频页重新选择。")


def _decode_side(card, record):
    """0 = auto: decode an upload straight to the size H3 will resize it to anyway."""
    if card["max_side"]:
        return card["max_side"]
    return h3_canvas_long_side(record.get("width"), record.get("height"))


def _segment_record(segment_store, card):
    index = segment_store.load_project_index(card["project"])
    return next((row for row in index.get("segments", [])
                 if row.get("segment_id") == card["segment_id"]), None)


def _load_video(card, label="视频"):
    _, segment_store, uploads, video_decode, _ = _helpers()
    if card["source"] == "uploads":
        path, record = uploads.resolve_upload(card["project"], card["segment_id"])
        _check_key(card, record, label)
        video, audio, _info = video_decode.decode_video(path, max_side=_decode_side(card, record))
    else:
        record = _segment_record(segment_store, card)
        if record is None:
            raise ValueError(f"{label}：裁切片段库「{card['project']}」里没有编号 {card['segment_id']} 的片段，请重新选择。")
        _check_key(card, record, label)
        video, audio, _meta = segment_store.load_segment(card["project"], card["segment_id"])
    return video, audio if audio is not None else _silent(int(video.shape[0]))


def _video_stamp(card):
    """What the cache key needs from one library video: the record and its file on disk.

    A segment re-cut into the same slot, a renumbered library or a replaced file all change
    this, so a cached bundle is reused only while the exact same bytes would be decoded.
    """
    _, segment_store, uploads, _decode, _ = _helpers()
    if card["source"] == "uploads":
        path, record = uploads.resolve_upload(card["project"], card["segment_id"])
        fields = (record.get("storage_name"), _decode_side(card, record))
    else:
        record = _segment_record(segment_store, card)
        if record is None:
            raise LookupError("segment is gone")
        folder = os.path.join(segment_store.get_project_dir(card["project"], create=False),
                              str(record.get("dir") or record.get("tag") or ""))
        path = os.path.join(folder, str(record.get("tensors_file") or ""))
        fields = (record.get("uid"), record.get("dir"), record.get("saved_at"), record.get("frames"))
    stat = os.stat(path)
    return repr((fields, stat.st_size, stat.st_mtime_ns))


def build_bundle(doc, target_megapixels=0.25, resampling_method="Lanczos", upscale_small_images=False):
    """Decode the active cards into one H3_REFS bundle (tensors + description)."""
    rows = assign_labels(doc)
    ref_nodes, _store, _uploads, _decode, ref_media = _helpers()
    roots = ref_nodes._media_roots()
    images, videos, audios = [], [], []
    summary = []
    for row in rows:
        card = row["card"]
        if row["kind"] == "image":
            path = ref_media.resolve_media_path(roots, card)
            tensor, plan, _source = ref_nodes.build_image_slot(
                path, target_megapixels, resampling_method, upscale_small_images)
            images.append(tensor)
            summary.append({"id": card["id"], "label": row["label"], "size": [plan["width"], plan["height"]]})
        elif row["kind"] == "audio":
            path = ref_media.resolve_media_path(roots, card)
            audio = ref_nodes.build_audio_slot(path, card["start"], card["duration"])
            audios.append(audio)
            summary.append({"id": card["id"], "label": row["label"],
                            "seconds": round(audio["waveform"].shape[-1] / audio["sample_rate"], 3)})
        else:
            video, audio = _load_video(card, row["label"][1:-1])
            videos.append({"frames": video, "audio": audio if card["use_audio"] else None})
            summary.append({"id": card["id"], "label": row["label"], "audio_label": row["audio_label"],
                            "frames": int(video.shape[0]), "size": [int(video.shape[2]), int(video.shape[1])]})
    bundle = refs_payload(doc, rows)
    bundle.update(images=images, videos=videos, audios=audios)
    return bundle, summary


def _pad_video(frames):
    """Repeat the last frame so the native node's 17n+5 cut removes no real frame."""
    extra = pad_to_17n5(int(frames.shape[0]))
    if not extra:
        return frames
    import torch
    return torch.cat([frames, frames[-1:].expand(extra, *frames.shape[1:])], dim=0)


def bundle_inputs(bundle, pad_videos=False):
    """Native Autogrow dictionaries in H3 order (images, videos + soundtracks, audios)."""
    if not isinstance(bundle, dict) or bundle.get("version") != 1:
        raise ValueError("素材包格式不对：请连接「H3 参考素材」节点的素材包输出。")
    images = list(bundle.get("images") or [])
    videos = list(bundle.get("videos") or [])
    audios = list(bundle.get("audios") or [])
    if len(images) > MAX_IMAGES or len(videos) > MAX_VIDEOS or len(audios) > MAX_AUDIOS:
        raise ValueError("素材包超出 H3 上限：图片 9、视频 3、音频 3。")
    if sum(1 for video in videos if video.get("audio") is not None) + len(audios) > MAX_AUDIOS + MAX_VIDEOS:
        raise ValueError("素材包里的音频数量超出上限。")
    return {
        "ref_images": {f"ref_image_{i}": value for i, value in enumerate(images)},
        "ref_videos": {f"ref_video_{i}": _pad_video(video["frames"]) if pad_videos else video["frames"]
                       for i, video in enumerate(videos)},
        "ref_video_audios": {f"ref_video_audio_{i}": video["audio"] for i, video in enumerate(videos)
                             if video.get("audio") is not None},
        "ref_audios": {f"ref_audio_{i}": value for i, value in enumerate(audios)},
    }


class H3ReferenceHub(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=NODE_ID, display_name="H3 参考素材",
            category="Amiaomiao H3/参考素材",
            description="在一个节点里管理参考图片、音频和视频，打包成一个素材包，连到「H3 参考生成视频（素材包）」。",
            inputs=[
                io.String.Input("references", default=EMPTY_DOC, multiline=True,
                                tooltip="面板写入的素材记录（JSON），随工作流保存。"),
                io.Float.Input("target_megapixels", default=0.25, min=0.02, max=8.0, step=0.01,
                               round=0.01, display_name="图片目标像素量（MP）"),
                io.Combo.Input("resampling_method", options=RESAMPLE_OPTIONS, default="Lanczos",
                               display_name="图片重采样"),
                io.Boolean.Input("upscale_small_images", default=False, display_name="小于目标时放大",
                                 tooltip="开启：比目标像素小的图片放大到目标像素；关闭：小图保持原尺寸，只微调到 32 的倍数。"),
            ],
            outputs=[
                H3Refs.Output(display_name="素材包"),
                io.String.Output(display_name="素材清单"),
            ],
        )

    @classmethod
    def validate_inputs(cls, references, **_kwargs):
        try:
            parse_document(references)
        except ValueError as exc:
            return str(exc)
        return True

    @classmethod
    def fingerprint_inputs(cls, references, target_megapixels=0.25, resampling_method="Lanczos",
                           upscale_small_images=False):
        try:
            doc = parse_document(references)
            ref_nodes, *_rest, ref_media = _helpers()
            roots = ref_nodes._media_roots()
        except Exception:
            return float("nan")
        digest = hashlib.sha256(repr((target_megapixels, resampling_method,
                                      bool(upscale_small_images))).encode())
        for card in doc["videos"]:
            digest.update(json.dumps([card["skip"], card["name"], card["purpose"], card["note"],
                                      card["source"], card["project"], card["segment_id"],
                                      card["use_audio"], card["max_side"], card["key"]],
                                     ensure_ascii=False).encode())
            if card["skip"]:
                continue
            try:
                digest.update(_video_stamp(card).encode())
            except Exception:
                return float("nan")  # let execute report the problem
        for card in doc["images"] + doc["audios"]:
            digest.update(json.dumps([card["skip"], card["name"], card["purpose"], card["note"]],
                                     ensure_ascii=False).encode())
            if card["skip"]:
                continue
            digest.update(repr((card["filename"], card["subfolder"], card["type"],
                                card.get("start"), card.get("duration"))).encode())
            try:
                stat = os.stat(ref_media.resolve_media_path(roots, card))
                digest.update(f"{stat.st_size}:{stat.st_mtime_ns}".encode())
            except (OSError, ValueError):
                digest.update(b"missing")
        return digest.hexdigest()

    @classmethod
    def execute(cls, references, target_megapixels=0.25, resampling_method="Lanczos",
                upscale_small_images=False):
        doc = parse_document(references)
        bundle, summary = build_bundle(doc, target_megapixels, resampling_method, upscale_small_images)
        logger.info("[H3 Reference Hub] %d images, %d videos, %d audios",
                    len(bundle["images"]), len(bundle["videos"]), len(bundle["audios"]))
        return io.NodeOutput(bundle, bundle["manifest"],
                             ui={"h3_refs": [{"items": summary, "manifest": bundle["manifest"]}]})


class H3ReferenceToVideo(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=REF2V_NODE_ID, display_name="H3 参考生成视频（素材包）",
            category="Amiaomiao H3/参考素材",
            description="接收「H3 参考素材」的素材包，按原生 MiniMax H3 Reference to Video 的顺序与编号生成条件。",
            inputs=[
                io.Clip.Input("clip"),
                H3Refs.Input("refs", display_name="素材包"),
                io.Vae.Input("vae", optional=True, tooltip="视频 VAE。不接时参考图片和视频只作用于文本编码。"),
                io.Vae.Input("audio_vae", optional=True, tooltip="音频 VAE。不接时参考音频只作用于文本编码。"),
                io.String.Input("prompt", multiline=True, dynamic_prompts=True),
                io.Int.Input("width", default=1344, min=32, max=16384, step=32),
                io.Int.Input("height", default=768, min=32, max=16384, step=32),
                io.Int.Input("length", default=124, min=5, max=3600, step=17,
                             tooltip="24fps 帧数（124 约 5 秒，训练范围约 124-362）。"),
                io.Combo.Input("ref_image_size", options=["match", "max"], default="match",
                               tooltip="match：参考图按生成画面面积缩小；max：按参考管线 2048 短边，身份更准但更慢。"),
                # Appended last: saved workflows restore widget values by position.
                io.Boolean.Input("follow_reference", default=False, display_name="跟随参考视频长度",
                                 label_on="是", label_off="否",
                                 tooltip="是：生成长度 = Video 1 的长度（对齐到 17n+5），上面的 length 不再生效；"
                                         "把「参考帧数」输出接到 Motion Context Trim 的 frames_cap，成片与参考视频一样长。\n"
                                         "否：按上面的 length 生成。"),
                io.Boolean.Input("pad_reference", default=True, display_name="保留参考视频结尾",
                                 tooltip="H3 只能按固定帧数读取参考视频。长度不合适时，原生节点会裁掉一点结尾。"
                                         "开启后会重复最后一帧补足长度，原来的动作都会保留。"),
                H3Settings.Input("settings", optional=True, display_name="生成设置",
                                 tooltip="接「H3 生成设置」后，宽高、length、跟随参考视频长度、保留参考视频结尾都以它为准，"
                                         "本节点上的这几项会隐藏。"),
                io.Combo.Input("sampling_pass", options=["一采", "二采"], default="一采", display_name="用于",
                               tooltip="接了生成设置时决定用哪组宽高：一采用基础尺寸，二采用放大后的尺寸。"),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Latent.Output(),
                io.Int.Output(display_name="length",
                              tooltip="这次实际使用的生成长度，可接给其他需要同一长度的节点。"),
                io.Int.Output(display_name="参考帧数",
                              tooltip="跟随参考视频时为 Video 1 的真实帧数，接 Motion Context Trim 的 frames_cap，"
                                      "解码后切掉补帧带来的尾巴；自定义时为 0（不裁尾）。"),
            ],
        )

    @classmethod
    def execute(cls, clip, refs, prompt, width, height, length, ref_image_size="match",
                vae=None, audio_vae=None, follow_reference=False, pad_reference=True,
                settings=None, sampling_pass="一采"):
        try:
            from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo
        except ImportError as exc:
            raise RuntimeError("当前 ComfyUI 没有 MiniMax H3 原生节点，请先更新 ComfyUI。") from exc
        if settings is not None:
            check_settings(settings)
            second = sampling_pass == "二采"
            width = settings["width_2"] if second else settings["width"]
            height = settings["height_2"] if second else settings["height"]
            length = settings["length"]
            follow_reference, pad_reference = settings["follow_reference"], settings["pad_reference"]
        inputs = bundle_inputs(refs, pad_videos=bool(pad_reference))
        videos = (refs or {}).get("videos") or []
        first = int(videos[0]["frames"].shape[0]) if videos else 0
        length, frames_cap = plan_length(bool(follow_reference), length, first)
        result = MiniMaxH3ReferenceToVideo.execute(
            clip, prompt, width, height, length, ref_image_size=ref_image_size,
            vae=vae, audio_vae=audio_vae, **inputs)
        return io.NodeOutput(*result.result, length, frames_cap)


class H3GenerationSettings(io.ComfyNode):
    """Duration, picture size for both passes and the reference options, in one place."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=SETTINGS_NODE_ID, display_name="H3 生成设置",
            category="Amiaomiao H3/参考素材",
            description="设定视频时长、画幅（比例 + 横竖 + 像素量）和二采放大倍率，一根线同时送给一采和二采。",
            inputs=[
                io.Float.Input("seconds", default=5.0, min=0.2, max=150.0, step=0.1, round=0.01,
                               display_name="视频时长（秒）"),
                io.Boolean.Input("follow_reference", default=False, display_name="跟随 Video 1",
                                 label_on="是", label_off="否"),
                io.Combo.Input("ratio", options=RATIO_NAMES, default="16:9", display_name="比例"),
                io.Combo.Input("orientation", options=ORIENTATIONS, default="横", display_name="方向"),
                io.Float.Input("megapixels", default=0.98, min=0.1, max=8.0, step=0.01, round=0.01,
                               display_name="像素量（MP）"),
                io.Float.Input("upscale", default=2.0, min=1.0, max=4.0, step=0.05, round=0.01,
                               display_name="二采放大倍率"),
                io.Boolean.Input("pad_reference", default=True, display_name="保留参考视频结尾",
                                 tooltip="H3 只能按固定帧数读取参考视频。长度不合适时，原生节点会裁掉一点结尾。"
                                         "开启后会重复最后一帧补足长度，原来的动作都会保留。"),
                io.Int.Input("custom_width", default=1344, min=64, max=8192, step=32, display_name="自定义宽"),
                io.Int.Input("custom_height", default=768, min=64, max=8192, step=32, display_name="自定义高"),
                H3Refs.Input("refs", optional=True, display_name="素材包",
                             tooltip="跟随 Video 1 时用来读取参考视频长度（可选）。"),
            ],
            outputs=[
                H3Settings.Output(display_name="生成设置"),
                io.Int.Output(display_name="一采宽", tooltip="一采画面宽度（已对齐 32）。接了「生成设置」的 Ref2V 不需要再接这个。"),
                io.Int.Output(display_name="一采高", tooltip="一采画面高度（已对齐 32）。接了「生成设置」的 Ref2V 不需要再接这个。"),
                io.Int.Output(display_name="二采宽",
                              tooltip="接原生「MiniMax H3 Latent Upscale With Model」的 width。"
                                      "二采 Ref2V 接「生成设置」并选“二采”时会用同一个值，放大后的 latent 与二采尺寸一致。"),
                io.Int.Output(display_name="二采高",
                              tooltip="接原生「MiniMax H3 Latent Upscale With Model」的 height。"
                                      "二采 Ref2V 接「生成设置」并选“二采”时会用同一个值，放大后的 latent 与二采尺寸一致。"),
                io.Int.Output(display_name="length", tooltip="生成帧数（24fps，对齐到 17n+5）。"),
                io.Float.Output(display_name="视频时长（秒）", tooltip="length ÷ 24。可接提示词编排器的时长。"),
            ],
        )

    @classmethod
    def execute(cls, seconds, follow_reference, ratio, orientation, megapixels, upscale,
                pad_reference=True, custom_width=1344, custom_height=768, refs=None):
        settings = build_settings(seconds, follow_reference, ratio, orientation, megapixels, upscale,
                                  pad_reference, custom_width, custom_height)
        videos = (refs or {}).get("videos") or [] if isinstance(refs, dict) else []
        ui = {k: settings[k] for k in ("width", "height", "width_2", "height_2", "length", "seconds")}
        if settings["follow_reference"]:
            if not videos:
                raise ValueError("「H3 生成设置」开启了成片长度跟随 Video 1，但素材包里没有启用的视频。请启用一个视频，或关闭这个开关。")
            frames = int(videos[0]["frames"].shape[0])
            settings["length"], settings["seconds"] = plan_length(True, 0, frames)[0], frames / 24.0
            item = next((row for row in (refs.get("items") or []) if row.get("kind") == "video"), {})
            ui.update(length=settings["length"], seconds=settings["seconds"], reference_frames=frames,
                      reference_name=item.get("name") or "Video 1")
        return io.NodeOutput(settings, settings["width"], settings["height"], settings["width_2"],
                             settings["height_2"], settings["length"], settings["length"] / 24.0,
                             ui={"h3_settings": [ui]})


class H3TwoPassSigmas(io.ComfyNode):
    """v3.2's sigma subgraph in one node: one schedule for both passes, low-noise extra steps, split."""

    @classmethod
    def define_schema(cls):
        import comfy.samplers
        from .two_pass import SPACINGS
        return io.Schema(
            node_id="AmiaomiaoH3_TwoPassSigmas", display_name="H3 两采 Sigma",
            category="Amiaomiao H3/参考素材",
            description="一采、二采共用一条噪声序列：按总步数生成，在低噪阶段加步细化，再在一采步数处切开。",
            inputs=[
                io.Model.Input("model"),
                io.Combo.Input("scheduler", options=comfy.samplers.SCHEDULER_NAMES, default="simple"),
                io.Int.Input("first_steps", default=6, min=1, max=200, display_name="一采步数",
                             tooltip="建议 4–8。"),
                io.Int.Input("second_steps", default=4, min=1, max=200, display_name="二采步数",
                             tooltip="建议 3–5。"),
                io.Int.Input("extra_steps", default=1, min=0, max=15, display_name="低噪加步",
                             tooltip="在低噪阶段额外加的步数，让细节成形的阶段走得更细，减轻快速运动边缘的颗粒和闪烁。0 = 不加。"),
                io.Float.Input("start_at_sigma", default=0.7, min=0.0, max=20.0, step=0.01,
                               display_name="加步起点 sigma", advanced=True),
                io.Float.Input("end_at_sigma", default=0.0, min=0.0, max=5.0, step=0.01,
                               display_name="加步终点 sigma", advanced=True),
                io.Combo.Input("spacing", options=list(SPACINGS), default="cosine", display_name="加步分布",
                               advanced=True, tooltip="cosine 越接近 0 越密。"),
            ],
            outputs=[
                io.Sigmas.Output(display_name="一采 sigmas"),
                io.Sigmas.Output(display_name="二采 sigmas"),
            ],
        )

    @classmethod
    def execute(cls, model, scheduler, first_steps, second_steps, extra_steps=1, start_at_sigma=0.7,
                end_at_sigma=0.0, spacing="cosine"):
        import comfy.samplers
        from .two_pass import refine_sigmas, split_two_pass
        sigmas = comfy.samplers.calculate_sigmas(model.get_model_object("model_sampling"), scheduler,
                                                 int(first_steps) + int(second_steps)).cpu()
        sigmas = refine_sigmas(sigmas, int(extra_steps), float(start_at_sigma), float(end_at_sigma), spacing)
        return io.NodeOutput(*split_two_pass(sigmas, int(first_steps)))


class H3SecondPassPrepare(io.ComfyNode):
    """Upscale the pass-1 latent to the pass-2 template size and reconcile it with the template."""

    @classmethod
    def define_schema(cls):
        from .two_pass import AUDIO_POLICIES, SECOND_PASS_AUDIO_SOURCES
        return io.Schema(
            node_id="AmiaomiaoH3_SecondPassPrepare", display_name="H3 二采准备",
            category="Amiaomiao H3/参考素材",
            description="把一采结果放大到二采尺寸（原生 MiniMax H3 latent 放大），再与二采模板、二采条件对齐并检查，"
                        "输出可以直接二采的 latent 和 positive。",
            inputs=[
                io.LatentUpscaleModel.Input("upscale_model", display_name="放大模型",
                                            tooltip="接原生「Load Latent Upscale Model」。"),
                io.Latent.Input("first_pass", display_name="一采 latent", tooltip="一采采样器的输出。"),
                io.Latent.Input("template", display_name="二采模板",
                                tooltip="二采「H3 参考生成视频（素材包）」的 LATENT。放大尺寸直接取它的大小，不需要另接宽高。"),
                io.Conditioning.Input("positive", display_name="二采 positive",
                                      tooltip="二采这一路的条件（二采 Motion Context / 时间轴之后）。接错成一采的条件会报错。"),
                io.Combo.Input("audio_policy", options=list(AUDIO_POLICIES), default="auto", advanced=True,
                               tooltip="auto：模板音频被锁定或局部重混时用模板音频，否则沿用一采音频。"),
                io.Combo.Input("second_pass_audio_source", options=list(SECOND_PASS_AUDIO_SOURCES),
                               default="legacy_policy", advanced=True,
                               tooltip="legacy_policy：按 audio_policy 决定，二采继续完善音频（默认）。"
                                       "first_pass：锁定一采音频，二采只细化画面。"),
                io.Float.Input("second_pass_audio_strength", default=0.0, min=0.0, max=1.0, step=0.01, advanced=True,
                               tooltip="只在 second_pass_audio_source 不是 legacy_policy 时生效。0 = 完全锁定所选音频。"),
            ],
            outputs=[
                io.Latent.Output(display_name="二采 latent"),
                io.Conditioning.Output(display_name="positive"),
                io.String.Output(display_name="报告"),
            ],
        )

    @classmethod
    def execute(cls, upscale_model, first_pass, template, positive, audio_policy="auto",
                second_pass_audio_source="legacy_policy", second_pass_audio_strength=0.0):
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3LatentUpscaleWithModel
        from .two_pass import nested_parts, reconcile_two_pass
        first_video, _audio = nested_parts(first_pass["samples"], "一采 latent")
        template_video, _audio = nested_parts(template["samples"], "二采模板")
        if first_video.shape[2] != template_video.shape[2]:
            raise ValueError(f"一采有 {first_video.shape[2]} 个 latent 帧，二采模板有 {template_video.shape[2]} 个。"
                             "两采的 length 必须相同（都接「H3 生成设置」即可）。")
        height, width = int(template_video.shape[3]) * 16, int(template_video.shape[4]) * 16
        src_h, src_w = int(first_video.shape[3]) * 16, int(first_video.shape[4]) * 16
        if width < src_w or height < src_h:
            raise ValueError(f"二采模板 {width}x{height} 比一采 {src_w}x{src_h} 小。latent 放大模型只能放大，"
                             "请检查二采 Ref2V 是否选了“二采”。")
        upscaled = MiniMaxH3LatentUpscaleWithModel.execute(upscale_model, first_pass, width, height).result[0]
        latent, positive_out, report = reconcile_two_pass(
            upscaled, template, positive, audio_policy, second_pass_audio_source, second_pass_audio_strength)
        report.update(first_pass_size=[src_w, src_h], second_pass_size=[width, height])
        return io.NodeOutput(latent, positive_out, json.dumps(report, ensure_ascii=False))


class H3Prompt(io.ComfyNode):
    """Plain H3 prompt text. The panel adds @ references to the connected hub's cards."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id=PROMPT_NODE_ID, display_name="H3 提示词",
            category="Amiaomiao H3/参考素材",
            description="直接输入或粘贴 H3 提示词；连接「H3 参考素材」后可用 @ 插入素材编号。",
            inputs=[
                io.String.Input("text", multiline=True, dynamic_prompts=True, default="",
                                display_name="提示词"),
                H3Refs.Input("refs", optional=True, display_name="素材包",
                             tooltip="连接「H3 参考素材」，面板里才能 @ 引用素材；不影响输出文本。"),
            ],
            outputs=[io.String.Output(display_name="提示词")],
        )

    @classmethod
    def execute(cls, text, refs=None):
        if isinstance(refs, dict):
            known = {item.get("label") for item in refs.get("items") or []}
            known |= {item.get("audio_label") for item in refs.get("items") or [] if item.get("audio_label")}
            missing = sorted(set(re.findall(r"<(?:Picture|Video|Audio) \d+>", text or "")) - known)
            if missing:
                logger.warning("[H3 Prompt] 提示词里的 %s 没有对应的启用素材", "、".join(missing))
        return io.NodeOutput(text or "")


class H3ReleaseTextEncoder(io.ComfyNode):
    """Free one CLIP after its prompts are encoded, and make the next run load it again."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="AmiaomiaoH3_ReleaseTextEncoder", display_name="H3 释放文本编码器",
            category="Amiaomiao H3/显存",
            description="一采和二采提示词都编码完成后，释放 CLIP 的显存和内存；下一次运行会重新加载。",
            inputs=[
                io.AnyType.Input("pass_through", display_name="继续",
                                 tooltip="接二采准备前的一根线，例如二采 Ref2V 的 LATENT；本节点会原样输出。"),
                io.Clip.Input("clip", display_name="CLIP",
                              tooltip="接同一个 CLIP 加载器的输出。"),
                io.Boolean.Input("enabled", default=False, display_name="释放文本编码器",
                                 label_on="开启", label_off="关闭",
                                 tooltip="关闭时原样透传。开启后，下一次运行要重新加载文本编码器，会多几秒。"),
            ],
            outputs=[io.AnyType.Output(display_name="继续")],
        )

    @classmethod
    def execute(cls, pass_through, clip, enabled=False):
        if not enabled:
            return io.NodeOutput(pass_through)
        import comfy.model_management as model_management
        from server import PromptServer

        patcher = getattr(clip, "patcher", None)
        model = getattr(patcher, "model", None)
        if model is None:
            raise ValueError("H3 释放文本编码器：没有找到可释放的 CLIP。请接 CLIP 加载器的输出。")
        for index in range(len(model_management.current_loaded_models) - 1, -1, -1):
            loaded = model_management.current_loaded_models[index].model
            if loaded is not None and loaded.clone_base_uuid == patcher.clone_base_uuid:
                model_management.current_loaded_models.pop(index)
        model.to("meta")
        PromptServer.instance.prompt_queue.set_flag("free_memory", True)
        model_management.cleanup_models_gc()
        gc.collect()
        model_management.soft_empty_cache()
        logger.info("[H3 释放文本编码器] 已释放 CLIP；本次运行结束后会清空节点缓存，下一次运行重新加载。")
        return io.NodeOutput(pass_through)


NODE_LIST = [H3ReferenceHub, H3ReferenceToVideo, H3GenerationSettings, H3TwoPassSigmas, H3SecondPassPrepare,
             H3Prompt, H3ReleaseTextEncoder]
