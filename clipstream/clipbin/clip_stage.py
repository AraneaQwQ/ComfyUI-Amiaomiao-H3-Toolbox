"""Select and verify the output graph of the opt-in H3 draft workflow."""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import os

from comfy_api.latest import io

from .clip_bin_manager import filter_clips_by_kind, get_project_dir, load_project_index, stage_card_category
from .v2_core import (FLOW_DUAL, FLOW_SINGLE, LATEST, MODE_CONTINUE, is_latest, normalize_mode,
                      normalize_passes, resolve_target, shot_label)

LOGGER = logging.getLogger(__name__)
PICKER = "AmiaomiaoH3_MiniMaxClipStagePicker"
SAVER = "AmiaomiaoH3_MiniMaxClipStageSaver"
ERROR = "AmiaomiaoH3_MiniMaxClipStageError"
PREPARE = "AmiaomiaoH3_SecondPassPrepare"
SAMPLER = "SamplerCustomAdvanced"
RELEASE_TEXT_ENCODER = "AmiaomiaoH3_ReleaseTextEncoder"
WIRE_LABELS = {"latent_1": "一采 latent", "draft_video": "草稿视频", "latent_2": "二采 latent", "video": "成片视频"}


def _fail(title, why, fix):
    """First line is the short title shown in the error list; the rest goes to the details tooltip."""
    return ValueError(f"{title}\n原因：{why}\n解决：{fix}")

# Restore literal settings, never a graph or a connection from disk. The current
# graph (and any non-restored inputs) must still match before we accept a replay.
SNAPSHOT = {
    "AmiaomiaoH3_GenerationSettings": {"seconds", "follow_reference", "ratio", "orientation",
                                      "megapixels", "pad_reference", "custom_width", "custom_height"},
    "AmiaomiaoH3_ReferenceHub": {"references", "target_megapixels", "resampling_method", "upscale_small_images"},
    "AmiaomiaoH3_Prompt": {"text"},
    "PrimitiveStringMultiline": {"value"},
    "AmiaomiaoH3_H3 Guide Timeline v2": {"guides", "enable_guide"},
    "AmiaomiaoH3_H3 Guide Timeline v2 B": {"enable_guide"},
    "Seed (rgthree)": {"seed"},
    "RandomNoise": {"noise_seed"},
}


def _is_link(value):
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and type(value[1]) is int


def _literal(value):
    return value is None or type(value) in (str, bool, int, float)


def _closure(graph, roots):
    seen, active = set(), set()

    def visit(node_id):
        if node_id in active:
            raise _fail(f"接线成环（节点 #{node_id}）", "这个节点的输出经过连线又绕回了它自己的输入，无法确定计算顺序。",
                        f"在画布上找到节点 #{node_id}，断开让它绕回自身的那根线。")
        if node_id in seen:
            return
        if node_id not in graph:
            raise _fail(f"找不到相连的节点 #{node_id}", "有连线指向这个节点，但它不在本次提交里（可能已删除或被静音）。",
                        f"恢复节点 #{node_id}，或删掉连到它的线。")
        active.add(node_id)
        for value in graph[node_id]["inputs"].values():
            if _is_link(value):
                visit(value[0])
        active.remove(node_id)
        seen.add(node_id)

    for root in roots:
        visit(root)
    return seen


def _wired(inputs, name):
    value = inputs.get(name)
    if not _is_link(value):
        label = WIRE_LABELS.get(name, name)
        raise _fail(f"片段保存缺少「{label}」输入（{name}）", f"抽卡要从 {name} 往上追溯，找出对应的采样分支。",
                    f"把{label}连到「H3 片段保存 v2」的 {name} 接口。")
    return value


def _samplers(graph, nodes):
    return {nid for nid in nodes if graph[nid]["class_type"] == SAMPLER}


def _slice(graph, reached):
    return {nid: node for nid, node in graph.items() if nid in reached}


def _recipe(graph):
    snapshots = {}
    canonical = {}

    def through_release(value):
        seen = set()
        while _is_link(value) and graph.get(value[0], {}).get("class_type") == RELEASE_TEXT_ENCODER:
            if value[0] in seen:
                raise _fail(f"接线成环（节点 #{value[0]}）", "释放文本编码器节点的 pass_through 又绕回了自己。",
                            f"断开节点 #{value[0]} 上绕回自身的那根线。")
            seen.add(value[0])
            value = graph[value[0]]["inputs"].get("pass_through")
        return value

    for nid, node in graph.items():
        kind = node["class_type"]
        if kind == RELEASE_TEXT_ENCODER:
            continue
        inputs = {name: through_release(value) for name, value in node["inputs"].items()}
        restorable = {k: v for k, v in inputs.items() if k in SNAPSHOT.get(kind, ()) and _literal(v)}
        if restorable:
            snapshots[nid] = restorable
        if kind == PICKER:
            inputs = {}
        elif kind == SAVER:
            inputs = {k: v for k, v in inputs.items() if k != "shot_tag"}
        elif kind == "AmiaomiaoH3_GenerationSettings" and _literal(inputs.get("upscale")):
            inputs = {k: v for k, v in inputs.items() if k != "upscale"}
        elif kind == "AmiaomiaoH3_MiniMaxH3OverlapRestoreClipStream" and inputs.get("color_follow_overlap") is False:
            inputs = {k: v for k, v in inputs.items() if k != "color_follow_overlap"}
        canonical[nid] = [kind, inputs]
    digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    return {"version": 1, "digest": digest, "inputs": snapshots}


def _restore(graph, recipe):
    if not isinstance(recipe, dict) or recipe.get("version") != 1 or not isinstance(recipe.get("inputs"), dict):
        raise _fail("这张卡没有可用的二采设置", "卡片里没有记录一采时的设置（可能是旧版本生成的，或记录已损坏）。",
                    "换一张卡做二采，或用当前工作流重新抽这一段的一采。")
    mismatch = _fail("当前工作流与这张卡不匹配",
                     "这张卡记录的节点在当前工作流里不存在或类型变了（例如删过、换过节点，或打开的是另一个工作流）。",
                     "打开生成这张卡时的工作流再运行二采；或用当前工作流重新抽一采。")
    for nid, fields in recipe["inputs"].items():
        node = graph.get(nid)
        if not node or not isinstance(fields, dict):
            raise mismatch
        for name, value in fields.items():
            if name not in SNAPSHOT.get(node["class_type"], ()) or name not in node["inputs"] \
                    or not _literal(value) or not _literal(node["inputs"][name]):
                raise mismatch
            node["inputs"][name] = value
    if _recipe(graph)["digest"] != recipe.get("digest"):
        raise _fail("工作流改动过，无法按这张卡重跑二采",
                    "二采必须沿用抽卡时的模型、采样参数和连线，现在有一项与当时不同。"
                    "提示词、种子、参考素材、生成设置会自动还原，不算改动。",
                    "把改过的模型、采样参数或连线改回去再运行；或者用现在的设置重新抽一采。")


def get_stage_card(project, clip_id, revision):
    if not clip_id.startswith("clip_") or any(c in clip_id for c in "\\/:") or not revision:
        raise _fail("还没选要二采的卡", "二采模式需要指定一张已完成一采的草稿卡。",
                    "在「H3 片段选择」里点选一张草稿卡，再运行。")
    cards = load_project_index(project).get("clips", [])
    match = next((c for c in cards if isinstance(c, dict) and c.get("clip_id") == clip_id), None)
    if match and filter_clips_by_kind(project, [match], "stage_dual"):
        if match.get("stage_revision") != revision or not match.get("stage_recipe"):
            raise _fail("这张卡已更新，选择已过期", "选中之后，这张卡又被重新生成或修改过。",
                        "在「H3 片段选择」里重新点选这张卡。")
        if match.get("locked") and match.get("variants", {}).get("二采", {}).get("has_latent"):
            raise _fail("这张成片已锁定", "它已有二采结果，锁定状态下不允许覆盖。",
                        "先在卡片上解锁，再运行二采。")
        return match
    raise _fail("这张卡不在当前项目里", f"项目「{project}」的双采片段库里找不到它（可能已删除，或项目名改过）。",
                "确认「H3 片段选择」的项目名，或重新选卡。")


def stage_parent(project, card):
    parent_id = card.get("parent_clip_id")
    if not parent_id or parent_id == "[INITIAL]":
        return None
    cards = load_project_index(project).get("clips", [])
    parent = next((c for c in filter_clips_by_kind(project, cards, "stage_dual") if c["clip_id"] == parent_id), None)
    if not parent or not parent.get("variants", {}).get("二采", {}).get("has_latent"):
        raise _fail("上一段已不存在或没有二采结果",
                    "这张卡当初是接在上一段之后抽的，二采也要用上一段的二采 latent 才能接上。",
                    "恢复上一段或先补完它的二采；不需要接续的话，改为「全新段落」重新抽卡。")
    return parent


def _second_size(graph, prep):
    from ...refs.core import build_settings

    template = graph[prep]["inputs"].get("template")
    ref = graph.get(template[0], {}) if _is_link(template) else {}
    inputs = ref.get("inputs", {})
    kind = ref.get("class_type")
    settings_id = None
    if kind == "AmiaomiaoH3_ReferenceToVideo" and inputs.get("sampling_pass") == "二采":
        link = inputs.get("settings")
        if _is_link(link) and link[1] == 0:
            settings_id = link[0]
    elif kind == "EmptyMiniMaxH3LatentAV":
        width, height = inputs.get("width"), inputs.get("height")
        if (_is_link(width) and _is_link(height) and width[0] == height[0]
                and (width[1], height[1]) == (3, 4)):
            settings_id = width[0]
    settings = graph.get(settings_id, {})
    if settings.get("class_type") != "AmiaomiaoH3_GenerationSettings":
        raise _fail("找不到二采的生成设置",
                    "接续前要从「二采准备」的 template 追溯到「H3 生成设置」的二采宽高。",
                    "将 template 接到二采 Ref2V，或接到由「二采宽」「二采高」驱动的原生 H3 空 AV Latent。")
    params = {k: v for k, v in settings["inputs"].items() if k != "refs"}
    if not all(_literal(v) for v in params.values()):
        raise _fail("无法预检二采分辨率", "「H3 生成设置」里有参数由其他节点连线传入，提交前算不出最终尺寸。",
                    "把这些参数改回直接填写的数值。")
    size = build_settings(**params)
    return [size["width_2"], size["height_2"]]


def check_second_size(parent, requested):
    if parent:
        shape = parent["variants"]["二采"].get("video_shape")
        if not isinstance(shape, list) or len(shape) != 5 or not all(type(n) is int and n > 0 for n in shape):
            raise _fail(f"上一段「{shot_label(parent)}」缺少分辨率记录",
                        "它的二采没有保存画面尺寸，无法确认能否接上。",
                        "重新生成上一段的二采，或改选别的片段接续。")
        before, after = [shape[4] * 16, shape[3] * 16], requested
        if list(after) != before:
            old, new = f"{before[0]}×{before[1]}", f"{after[0]}×{after[1]}"
            raise _fail(f"接续分辨率不一致（上一段 {old}，本次 {new}）",
                        f"接续会把上一段「{shot_label(parent)}」结尾的画面交给这一段继续生成，两段二采尺寸必须相同。",
                        f"任选其一：① 在「H3 生成设置」把比例、方向、像素量、二采放大倍率改回上一段的值，使二采为 {old}；"
                        "② 在「H3 片段选择」改选尺寸相同的片段接续；③ 不需要接续时改为「全新段落」。")


def continued_card(project, selection):
    clips = load_project_index(project).get("clips", [])
    folder = get_project_dir(project)
    completed = [c for c in filter_clips_by_kind(project, clips, "stage_dual")
                 if stage_card_category(os.path.join(folder, c["clip_id"]), c) == "dual"]
    if not completed and not is_latest(selection):
        raise _fail("固定的接续片段已不可用", "片段选择固定接在某一段之后，但它已被删除，或还没完成二采。",
                    "在「H3 片段选择」重新选接续片段，或打开「跟随最新」。")
    return resolve_target(completed, selection)


def plan_submission(graph):
    """Return (prepared API graph, output allowlist). None means unrelated workflow."""
    pickers = [nid for nid, node in graph.items() if node.get("class_type") == PICKER]
    if not pickers and not any(node.get("class_type") == SAVER for node in graph.values()):
        return None
    if len(pickers) != 1:
        if not pickers:
            raise _fail("缺少「H3 片段选择」", "工作流里有片段保存，但没有片段选择，无法决定这次跑哪一步。",
                        "添加「H3 片段选择」，把它的「接续信息」连到片段保存的 link。")
        raise _fail(f"「H3 片段选择」有 {len(pickers)} 个", "抽卡只能由一个片段选择决定跑哪一步。",
                    "只保留一个，其余删除或静音。")
    graph = copy.deepcopy(graph)
    _closure(graph, graph)
    picker = pickers[0]
    savers = [nid for nid, node in graph.items() if node["class_type"] == SAVER]
    if len(savers) != 1:
        raise _fail(f"「H3 片段保存 v2」有 {len(savers)} 个", "抽卡需要且只能有一个片段保存来接收结果。",
                    "保留一个片段保存，其余删除或静音。" if savers else "添加「H3 片段保存 v2」，并把片段选择的「接续信息」连到它的 link。")
    if graph[savers[0]]["inputs"].get("link") != [picker, 2]:
        raise _fail("片段选择与片段保存没连上", "片段保存要从片段选择拿到这次的接续信息。",
                    "把「H3 片段选择」的「接续信息」输出连到「H3 片段保存 v2」的 link 输入。")
    saver = savers[0]
    pin, sin = graph[picker]["inputs"], graph[saver]["inputs"]
    first = _wired(sin, "latent_1")
    first_video = _wired(sin, "draft_video")
    first_path = _closure(graph, [first[0]])
    first_samplers = _samplers(graph, first_path)
    if len(first_samplers) != 1:
        raise _fail(f"一采分支的采样器数量不对（找到 {len(first_samplers)} 个）",
                    f"从片段保存的 latent_1 往上追，应恰好经过一个 {SAMPLER}（目前只识别这种采样器）。",
                    f"把 latent_1 接到一采 {SAMPLER} 的输出；分支里有多个采样器时去掉多余的。")

    flow = normalize_passes(pin.get("passes"))
    refine_id = str(pin.get("refine_clip") or "")
    revision = str(pin.get("refine_revision") or "")
    project = str(pin.get("project_name") or "Default_Project").strip()
    stage = "single" if flow == FLOW_SINGLE else "second" if refine_id else "first" if pin.get("draft_only") else "full"
    plan = {"stage": stage}

    if flow == FLOW_DUAL:
        second = _wired(sin, "latent_2")
        second_video = _wired(sin, "video")
        second_path = _closure(graph, [second[0]])
        second_samplers = _samplers(graph, second_path) - first_samplers
        prep = [nid for nid in second_path if graph[nid]["class_type"] == PREPARE]
        if len(prep) != 1:
            raise _fail(f"二采分支的「二采准备」数量不对（找到 {len(prep)} 个）",
                        "从片段保存的 latent_2 往上追，应恰好经过一个「二采准备」。",
                        "把 latent_2 接到经过「二采准备」的二采采样器输出；多余的「二采准备」去掉。")
        if graph[prep[0]]["inputs"].get("first_pass") != first:
            raise _fail("「二采准备」的 first_pass 没接一采 latent",
                        "二采必须从片段保存 latent_1 用的那份一采 latent 开始。",
                        "把连到 latent_1 的那个输出，同时连到「二采准备」的 first_pass。")
        if len(second_samplers) != 1:
            raise _fail(f"二采分支的采样器数量不对（找到 {len(second_samplers)} 个）",
                        f"除一采外，latent_2 的上游应恰好有一个 {SAMPLER}。",
                        f"把 latent_2 接到二采 {SAMPLER} 的输出；去掉多余的采样器。")
        if not second_samplers <= _closure(graph, [second_video[0]]):
            raise _fail("成片视频不是二采的结果", "片段保存的 video 往上追，没有经过二采采样器。",
                        "把二采解码出的视频接到片段保存的 video。")
        replay = copy.deepcopy(graph)
        replay[prep[0]]["inputs"]["first_pass"] = [picker, 4]
        replay_saver = replay[saver]["inputs"]
        replay_saver["latent_1"] = [picker, 4]
        replay_saver.pop("draft_video")
        reach = _closure(replay, [saver])
        if _samplers(replay, reach) != second_samplers or first[0] in reach:
            raise _fail("二采分支还依赖一采",
                        "单独跑二采时一采会被跳过，但二采分支里还有 first_pass 以外的线取自一采。",
                        "检查二采分支，去掉直接来自一采采样器或其下游的连线。")
        replay = _slice(replay, reach)
        if stage == "second":
            card = get_stage_card(project, refine_id, revision)
            _restore(replay, card["stage_recipe"])
            parent = stage_parent(project, card)
            if parent:
                requested = _second_size(replay, prep[0])
                check_second_size(parent, requested)
                plan["second_size"] = requested
            plan.update(clip_id=refine_id, revision=revision)
            graph = replay
        else:
            plan["recipe"] = _recipe(replay)
            if stage == "full" and normalize_mode(pin.get("mode")) == MODE_CONTINUE:
                requested = _second_size(graph, prep[0])
                check_second_size(continued_card(project, pin.get("clip_selection", LATEST)), requested)
                plan["second_size"] = requested

    if stage in ("first", "single"):
        sin["video"] = first_video
        for key in ("latent_2", "draft_video", "images", "audio"):
            sin.pop(key, None)
        reach = _closure(graph, [saver])
        if _samplers(graph, reach) != first_samplers or not first_samplers <= _closure(graph, [first_video[0]]) \
                or any(graph[nid]["class_type"] == PREPARE for nid in reach):
            raise _fail("草稿视频接到了二采", "只跑一采时，片段保存的 draft_video 必须只来自一采。",
                        "把一采解码出的视频接到片段保存的 draft_video。")
        graph = _slice(graph, reach)
    if stage == "full":
        sin.pop("draft_video")
    graph[picker]["inputs"]["stage_plan"] = json.dumps(plan, ensure_ascii=False)
    # Removing all unneeded nodes also protects hosts that do not support partial targets.
    # Keep every original output for normal dual mode (compare, cache cleanup, etc.).
    return graph, (None if stage == "full" else [saver])


class ClipStageError(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="MiniMaxClipStageError", display_name="H3 抽卡检查", category="MiniMaxH3/ClipStream",
                         inputs=[io.String.Input("message")], is_output_node=True)

    @classmethod
    def validate_inputs(cls, message):
        return message or "抽卡工作流未通过检查。"

    @classmethod
    def execute(cls, message):
        raise ValueError(message)


def _targets_touch_stage(prompt, targets):
    """True when partial_execution_targets is absent or actually reaches PICKER / SAVER."""
    if not isinstance(targets, (list, tuple)) or not targets:
        return True
    valid = [str(tid) for tid in targets if str(tid) in prompt]
    if not valid:
        return True
    try:
        reached = _closure(prompt, valid)
    except ValueError:
        return True
    return any(
        isinstance(prompt.get(nid), dict) and prompt[nid].get("class_type") in (PICKER, SAVER)
        for nid in reached
    )


def route_submission(data):
    prompt = data.get("prompt")
    if not isinstance(prompt, dict) or not any(isinstance(node, dict) and node.get("class_type") in (PICKER, SAVER)
                                              for node in prompt.values()):
        return data
    if not _targets_touch_stage(prompt, data.get("partial_execution_targets")):
        return data
    try:
        outcome = plan_submission(prompt)
        if outcome is None:
            return data
        graph, targets = outcome
        if targets is None:
            return {**data, "prompt": graph}
        return {**data, "prompt": graph, "partial_execution_targets": targets}
    except Exception as exc:
        if isinstance(exc, ValueError):
            LOGGER.warning("H3 draft workflow rejected: %s", str(exc).split("\n", 1)[0])
            message = f"H3 抽卡：{exc}"
        else:
            LOGGER.exception("H3 draft workflow check crashed")
            message = (f"H3 抽卡：提交前检查出错\n原因：{type(exc).__name__}: {exc}\n"
                       "解决：这是插件问题，不是你的设置问题。请把控制台里的报错和工作流发给作者。")
        error_id = next((nid for nid, node in prompt.items()
                         if isinstance(node, dict) and node.get("class_type") == PICKER), "1")
        error = {"class_type": ERROR, "inputs": {"message": message}}
        return {**data, "prompt": {error_id: error}, "partial_execution_targets": [error_id]}


def register_clip_stage_router():
    from server import PromptServer
    server = PromptServer.instance
    if route_submission not in server.on_prompt_handlers:
        server.add_on_prompt_handler(route_submission)
