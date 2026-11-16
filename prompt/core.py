"""Versioned prompt documents and the shared UI/API compiler."""
from copy import deepcopy
from fractions import Fraction
import json
import re

FIELDS = (
    "subject_definitions", "summary", "retention_analysis",
    "detailed_description", "overall_soundscape", "non_diegetic_music",
)
TASKS = (
    "keyframe completion", "reference generation", "video editing",
    "video continuation", "audio reuse", "audio reference",
)
VISUAL_RELATIONS = ("fully_preserved", "partially_preserved", "attribute_transfer", "weak_reference")
AUDIO_RELATIONS = ("fully_copy", "partially_copy", "reference", "weak_reference")
LANGUAGES = ("Chinese", "English", "Japanese", "Korean", "Cantonese", "French", "Spanish", "German")
TOKEN = re.compile(r"\{\{(ref|def):([^{}]+)\}\}")
MAX_DOCUMENT_BYTES = 1_000_000


def default_document():
    return {
        "version": 1, "mode": "compose", "native_text": "", "duration_ms": 10000,
        "tasks": ["reference generation"], "summary": "", "style": "",
        "assets": [], "definitions": [],
        "shots": [{"id": "shot-first", "start_ms": 0, "runs": []}],
        "mc": {"enabled": False, "mode": "continue", "fps": 24,
               "overlap_frames": None, "trim_frames": None, "carry": [], "source": "manual"},
        "soundscape": "", "music": {"enabled": False, "text": ""},
        "overrides": {},
    }


def parse_document(raw):
    if isinstance(raw, str):
        if len(raw.encode("utf-8")) > MAX_DOCUMENT_BYTES:
            raise ValueError("提示词文档超过 1 MB。")
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise ValueError("提示词文档不是有效 JSON。") from exc
    if not isinstance(raw, dict) or raw.get("version", 1) != 1:
        raise ValueError("不支持的提示词文档版本。")
    doc = default_document()
    doc.update(deepcopy(raw))
    if doc["mode"] not in ("compose", "native"):
        raise ValueError("输入模式必须是 compose 或 native。")
    for field, limit in (("assets", 300), ("definitions", 100), ("shots", 100)):
        items = doc[field]
        if not isinstance(items, list) or not items and field == "shots" or len(items) > limit:
            raise ValueError(f"{field} 列表为空、格式错误或超出数量限制。")
        identities = []
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                raise ValueError(f"{field} 条目缺少稳定 ID。")
            identities.append(item["id"])
        if len(set(identities)) != len(identities):
            raise ValueError(f"{field} 出现重复 ID。")
    if not isinstance(doc["mc"], dict) or not isinstance(doc["music"], dict):
        raise ValueError("MC 或配乐配置格式错误。")
    if not isinstance(doc["overrides"], dict):
        raise ValueError("六段锁定配置格式错误。")
    if not isinstance(doc["native_text"], str):
        raise ValueError("原生输入必须是文本。")
    for key in ("summary", "style", "soundscape"):
        if not isinstance(doc[key], str):
            raise ValueError(f"{key} 必须是文本。")
    if not isinstance(doc["music"].get("text", ""), str) or not isinstance(doc["mc"].get("carry", []), list):
        raise ValueError("配乐或承接区格式错误。")
    return doc


def timestamp(seconds):
    milliseconds = round(float(seconds) * 1000)
    return f"{milliseconds // 60000:02d}:{milliseconds // 1000 % 60:02d}.{milliseconds % 1000:03d}"


def compile_document(raw, *, mc_overlap_frames=None, mc_trim_frames=None):
    doc = parse_document(raw)
    issues = []

    def issue(level, path, message):
        row = {"level": level, "path": path, "message": message}
        if row not in issues:
            issues.append(row)

    if doc["mode"] == "native":
        return {"prompt": doc["native_text"], "document": doc, "fields": {},
                "issues": [], "speaker_map": {}, "translation": "原生文本原样输出"}

    def number(value, path, *, integer=False, minimum=0, maximum=3_600_000):
        if isinstance(value, bool) or not isinstance(value, (int, float, Fraction)):
            issue("error", path, "请填写有效数值。")
            return None
        try:
            result = Fraction(str(value))
            if not minimum <= result <= maximum or integer and result.denominator != 1:
                raise ValueError()
        except (ValueError, ZeroDivisionError, OverflowError):
            issue("error", path, "数值超出范围或应为整数。")
            return None
        return result

    duration = number(doc["duration_ms"], "duration_ms", minimum=1)
    duration = (duration or 10000) / 1000
    mc = {"fps": 24, "mode": "continue", "carry": [], **doc["mc"]}
    if mc_overlap_frames is not None and mc_overlap_frames >= 0:
        mc.update(enabled=True, overlap_frames=mc_overlap_frames, source="connected")
    if mc_trim_frames is not None and mc_trim_frames >= 0:
        mc.update(enabled=True, trim_frames=mc_trim_frames, source="connected")
    doc["mc"] = mc
    overlap = trim = None
    if mc.get("enabled"):
        fps = number(mc["fps"], "mc.fps", integer=True, minimum=1, maximum=240)
        if fps != 24:
            issue("warning", "mc.fps", "本工作流按 24 fps 设计，请核对接续节点实际帧率。")
        for key in ("overlap_frames", "trim_frames"):
            if mc.get(key) is None:
                issue("warning", "mc." + key, "实际边界待确认；请接线读取或手动填写，不按默认 22 帧推断。")
            else:
                frames = number(mc[key], "mc." + key, integer=True, maximum=4096)
                if frames is not None and fps:
                    if key == "trim_frames":
                        trim = frames / fps
                    else:
                        overlap = frames / fps
        if trim is not None and trim >= duration:
            issue("error", "mc.trim_frames", "裁切区已覆盖整个片段。")
        if mc["mode"] not in ("continue", "cut"):
            issue("error", "mc.mode", "MC 模式必须是继续原镜头或切入下一镜。")

    shots = deepcopy(doc["shots"])
    if shots[0].get("start_ms") != 0:
        issue("error", "shots.0.start_ms", "Shot 1 必须从 0 秒开始。")
    if mc.get("enabled") and mc["mode"] == "cut":
        if trim is None:
            issue("error", "mc.trim_frames", "切入下一镜前需确认实际裁切边界。")
        shots[0]["start_ms"] = (trim or 0) * 1000
        shots.insert(0, {"id": "mc-carry", "start_ms": 0, "runs": mc["carry"], "carry": True})
    elif mc.get("enabled"):
        shots[0]["runs"] = [*mc["carry"], *shots[0].get("runs", [])]

    starts = []
    previous = Fraction(-1)
    for index, shot in enumerate(shots):
        start = number(shot.get("start_ms"), f"shots.{shot['id']}.start_ms")
        start = start / 1000 if start is not None else previous
        if start <= previous or start >= duration:
            issue("error", f"shots.{shot['id']}.start_ms", "切镜时间须严格递增，并小于本段时长。")
        if index and overlap is not None and start < overlap:
            issue("warning", f"shots.{shot['id']}.start_ms", "切镜位于重叠承接区，请核对连续性。")
        starts.append(start)
        previous = start
    shot_numbers = {shot["id"]: index + 1 for index, shot in enumerate(shots)}
    assets = {a["id"]: a for a in doc["assets"]}
    definitions = {d["id"]: d for d in doc["definitions"]}
    definition_labels = {}
    counts = {"Subject": 0}
    used_slots = {}

    def asset_label(asset_id, path, expected=None):
        asset = assets.get(asset_id)
        if not asset or asset.get("missing") or asset.get("skip"):
            issue("error", path, "引用素材已失效或被跳过，请刷新并重新确认。")
            return "[失效素材]"
        if asset.get("mapping_changed"):
            issue("error", path, "素材实际接线编号已变化，请刷新后重新确认正式编号。")
        kind = expected or {"image": "Picture", "audio": "Audio", "video": "Video"}.get(asset.get("kind"))
        if kind not in ("Picture", "Audio", "Video"):
            issue("error", path, "不支持的素材类型。")
            return "[未知素材]"
        if expected == "Audio" and asset.get("kind") == "video" and not asset.get("audio_enabled"):
            issue("error", path, "需显式启用该视频的原音轨，并指定独立 Audio 编号。")
        slot = asset.get("audio_slot") if kind == "Audio" and asset.get("kind") == "video" else asset.get("slot")
        if isinstance(slot, bool) or not isinstance(slot, int) or not 1 <= slot <= 99:
            issue("error", path, "请按实际参考输入接线指定正式编号；不能用卡片排列猜编号。")
            return f"<{kind} ?>"
        label = f"<{kind} {slot}>"
        other = used_slots.setdefault(label, asset_id)
        if other != asset_id:
            issue("error", path, f"{label} 对应多个不同素材，请核对实际输入。")
        return label

    for item in doc["definitions"]:
        kind = item.get("kind", "Subject")
        if kind == "Subject":
            counts[kind] += 1
            definition_labels[item["id"]] = f"<Subject {counts[kind]}>"
        elif kind in ("Picture", "Video", "Audio"):
            sources = item.get("sources", [])
            if len(sources) != 1:
                issue("error", "definitions." + item["id"], "独立 Picture、Video 或 Audio 定义须选择一个来源。")
            source = sources[0].get("asset_id") if sources else None
            asset = assets.get(source, {})
            valid_kinds = {"Picture": ("image",), "Video": ("video",), "Audio": ("audio", "video")}
            if asset.get("kind") not in valid_kinds[kind]:
                issue("error", "definitions." + item["id"], "定义类型与来源素材类型不符。")
            definition_labels[item["id"]] = asset_label(source, "definitions." + item["id"], kind)
        else:
            issue("error", "definitions." + item["id"], "定义类型无效。")
            definition_labels[item["id"]] = "[无效定义]"
    labels = list(definition_labels.values())
    if len(set(labels)) != len(labels):
        issue("error", "definitions", "同一正式标签有重复定义；同一音频的多种用途请合并到一条定义。")

    def text(value, path):
        if not isinstance(value, str):
            issue("error", path, "文本格式错误。")
            return ""
        def replace(match):
            kind, identity = match.groups()
            if kind == "ref":
                return asset_label(identity, path)
            if identity not in definition_labels:
                issue("error", path, "引用的定义已被删除。")
                return "[失效定义]"
            return definition_labels[identity]
        return TOKEN.sub(replace, value)

    speakers = {}
    vocal_events = []
    for i, shot in enumerate(shots):
        runs = shot.get("runs", [])
        if not isinstance(runs, list) or len(runs) > 2000:
            raise ValueError("镜头正文格式错误或内容过多。")
        end = starts[i + 1] if i + 1 < len(starts) else duration
        for j, run in enumerate(runs):
            if not isinstance(run, dict):
                raise ValueError("正文片段必须是对象。")
            path = f"shots.{shot['id']}.runs.{j}"
            if run.get("kind") in ("dialogue", "event"):
                moment = run.get("start_ms")
                when = None if moment is None else number(moment, path + ".start_ms")
                when = when / 1000 if when is not None else None
                if when is not None and not starts[i] <= when < end:
                    issue("error", path, "镜头内时间点超出当前镜头范围；不会自动移动。")
                if run["kind"] == "event" and moment is None:
                    issue("error", path, "请填写镜头内事件时间。")
                if run["kind"] == "dialogue":
                    if shot.get("carry"):
                        issue("error", path, "承接裁切区不能安排台词或发声事件。")
                    if when is None:
                        issue("warning", path, "发声时间未填写，请确认先后顺序和裁切边界。")
                    elif trim is not None and when < trim:
                        issue("error", path, "发声落在实际裁切区，成片会丢失这段声音。")
                    vocal_events.append((when if when is not None else starts[i], i, j, run, path))
    for _, _, _, run, path in sorted(vocal_events, key=lambda entry: entry[:3]):
        speaker = run.get("speaker")
        if speaker not in definitions and speaker != "narrator":
            issue("error", path, "请选择有效发声者；被删除的角色不会自动替换。")
        elif speaker != "narrator" and definitions[speaker].get("kind") != "Subject":
            issue("error", path, "发声者必须是 Subject 定义。")
        if speaker:
            speakers.setdefault(speaker, f"S{len(speakers) + 1}")

    def render_runs(runs, path, carry=False):
        output = []
        for i, run in enumerate(runs):
            location = f"{path}.{i}"
            kind = run.get("kind", "text")
            if kind == "text":
                value = text(run.get("text", ""), location)
                if carry and re.search(r"<d>|[“”「」]|(?:says|speaks|台词|说道)", value):
                    issue("warning", location, "承接区疑似粘贴了对白，请确认裁切区无台词。")
                output.append(value)
            elif kind == "ref":
                output.append(text("{{" + run.get("target", "ref") + ":" + str(run.get("id", "")) + "}}", location))
            elif kind == "event":
                moment = run.get("start_ms")
                valid = number(moment, location + ".start_ms") if moment is not None else None
                prefix = f"At {timestamp(valid / 1000)}, " if valid is not None else ""
                output.append(prefix + text(run.get("text", ""), location))
            elif kind == "dialogue":
                speaker = run.get("speaker")
                label = definition_labels.get(speaker, text(run.get("voice_description", ""), location))
                if speaker == "narrator" and not label:
                    issue("error", location, "旁白需填写稳定的声音描述。")
                speech = text(run.get("text", ""), location)
                if not speech.strip():
                    issue("error", location, "台词或发声内容为空。")
                language = run.get("language")
                verb = run.get("delivery", "says")
                verbs = {"says": "says", "sings": "sings", "offscreen": "speaks off-screen",
                         "voiceover": "speaks in voice-over", "laughs": "laughs", "gasps": "gasps"}
                if verb not in verbs:
                    issue("error", location, "不支持的发声形式。")
                if language not in LANGUAGES and verb not in ("laughs", "gasps"):
                    issue("error", location, "请选择台词语言。")
                cues = [text(run.get("mood", ""), location), text(run.get("emphasis", ""), location)]
                voice_refs = [
                    definition_labels[d["id"]] for d in doc["definitions"]
                    if d.get("kind") == "Audio" and d.get("purpose") == "voice"
                    and d.get("speaker") == speaker
                ]
                if voice_refs:
                    cues.append("using the voice timbre referenced from " + ", ".join(voice_refs))
                when = run.get("start_ms")
                valid = number(when, location + ".start_ms") if when is not None else None
                prefix = f"At {timestamp(valid / 1000)}, " if valid is not None else ""
                cue = ", ".join(c for c in cues if c)
                lead = f"{prefix}{label} ({speakers.get(speaker, 'S?')}) {verbs.get(verb, 'says')}"
                if cue:
                    lead += ", " + cue
                output.append(lead + (", " + speech if verb in ("laughs", "gasps")
                                     else f", <d>[{language or '?'}] {speech}</d>"))
            else:
                issue("error", location, "不支持的正文片段。")
        return " ".join(part for part in output if part)

    task_list = doc.get("tasks")
    if not isinstance(task_list, list) or any(t not in TASKS for t in task_list):
        issue("error", "tasks", "任务类型无效。")
        task_list = []
    task_list = list(dict.fromkeys(task_list))
    definitions_text, retention = [], []
    for item in doc["definitions"]:
        identity = item["id"]
        path = "definitions." + identity
        label = definition_labels[identity]
        kind = item.get("kind", "Subject")
        relation = item.get("relation", "reference" if kind == "Audio" else "fully_preserved")
        if relation not in (AUDIO_RELATIONS if kind == "Audio" else VISUAL_RELATIONS):
            issue("error", path + ".relation", "当前定义类型不能使用该参考关系。")
        desc = text(item.get("description", ""), path)
        if not desc.strip():
            issue("error", path, "请填写定义内容。")
        sources = []
        for source in item.get("sources", []):
            source_label = asset_label(source.get("asset_id"), path, "Audio" if kind == "Audio" else None)
            role = text(source.get("role", ""), path)
            sources.append(source_label + (": " + role if role else ""))
        scope = item.get("scope", [])
        if not isinstance(scope, list):
            issue("error", path + ".scope", "生效镜头格式错误。")
            scope = []
        for shot in scope:
            if shot not in shot_numbers:
                issue("error", path + ".scope", "生效范围引用了已删除镜头。")
        scope_text = ", ".join(f"[Shot {shot_numbers[s]}]" for s in scope if s in shot_numbers) or "all shots"
        extras = []
        if item.get("purpose"):
            extras.append("Role: " + text(item["purpose"], path))
        if item.get("anchor_ms") is not None:
            anchor = number(item["anchor_ms"], path + ".anchor_ms")
            if anchor is not None:
                if anchor / 1000 >= duration:
                    issue("error", path, "锚点时间超出本段时长。")
                extras.append("Anchor time: " + timestamp(anchor / 1000))
        if kind == "Audio" and item.get("purpose") == "voice":
            speaker = item.get("speaker")
            if speaker not in speakers:
                issue("warning", path, "音色绑定角色尚未在镜头中发声。")
            else:
                extras.append(f"Voice-timbre reference for {definition_labels.get(speaker, 'narrator')} ({speakers[speaker]})")
            if relation not in ("reference", "weak_reference"):
                issue("warning", path, "音色参考通常使用 reference，不代表复制原录音。")
            if "audio reference" not in task_list:
                issue("warning", "tasks", "音色参考需要选择「音频参考」任务。")
        if kind == "Audio" and relation == "fully_copy" and (
                doc["soundscape"].strip() or doc["music"].get("enabled") or vocal_events):
            issue("warning", path, "完整复制要求源音频就是全部最终音轨；另加声音时请核对是否应为部分复制。")
        if relation == "attribute_transfer" and not item.get("transfer_target"):
            issue("error", path, "属性转移需填写不同的可识别目标。")
        if item.get("transfer_target"):
            extras.append("Transfer target: " + text(item["transfer_target"], path))
        line = f"{label} {desc}"
        if sources:
            line += " Sources: " + "; ".join(sources) + "."
        if extras:
            line += " " + "; ".join(extras) + "."
        definitions_text.append(line)
        explanation = " ".join(filter(None, (
            text(item.get("keep", ""), path),
            ("Changes: " + text(item["change"], path)) if item.get("change") else "",
        )))
        retention.append(f"{label} ({scope_text}): {relation}" + (" - " + explanation if explanation else ""))

    summary = text(doc["summary"], "summary")
    if "video editing" in task_list:
        video = next((definition_labels[d["id"]] for d in doc["definitions"] if d.get("kind") == "Video"), None)
        if video is None:
            issue("error", "summary", "视频编辑需要独立的 Video 来源定义。")
        summary = f"The target video is an edited version of {video or '<Video ?>'}. " + summary
    detailed = [text(doc["style"], "style")]
    if mc.get("enabled"):
        render_runs(mc["carry"], "mc.carry", carry=True)
        if any(run.get("kind") == "dialogue" for run in mc["carry"]):
            issue("error", "mc.carry", "承接裁切区不能安排台词或发声事件。")
    for i, shot in enumerate(shots):
        body = render_runs(shot.get("runs", []), "shots." + shot["id"], carry=shot.get("carry", False))
        if not body.strip():
            issue("warning", "shots." + shot["id"], "镜头正文为空。")
        heading = "[Shot 1]" if i == 0 else f"[Shot {i + 1}] At {timestamp(starts[i])},"
        detailed.append(heading + " " + body)
    fields = dict(zip(FIELDS, (
        "\n".join(definitions_text) or "N/A",
        ("[" + " + ".join(task_list) + "] " if task_list else "") + summary,
        "\n".join(retention) or "N/A",
        "\n".join(filter(None, detailed)),
        text(doc["soundscape"], "soundscape") or "N/A",
        text(doc["music"].get("text", ""), "music.text") if doc["music"].get("enabled") else "N/A",
    )))
    if doc["music"].get("enabled") and not fields["non_diegetic_music"].strip():
        issue("error", "music.text", "已开启配乐，请填写乐器、节奏、情绪、动态及收尾需求。")
    for key in FIELDS:
        override = doc["overrides"].get(key)
        if isinstance(override, dict) and override.get("locked"):
            fields[key] = text(override.get("text", ""), "overrides." + key)
            issue("warning", "overrides." + key, "此段已手动锁定；请复核编号、台词与镜头是否仍和其他段一致。")
    for key in FIELDS:
        if key != "detailed_description" and "<d>" in fields[key]:
            issue("error", key, "完整台词只能放在详细镜头描述中。")
    if re.search(r"[\u3400-\u9fff]", "\n".join(re.sub(r"<d>.*?</d>", "", v, flags=re.S) for v in fields.values())):
        issue("warning", "translation", "正文仍含中文；当前仅确定性编排，不会自动翻译成完整英文成品。")
    return {
        "prompt": "\n\n".join(key + ":\n" + fields[key] for key in FIELDS),
        "document": doc, "fields": fields, "issues": issues, "speaker_map": speakers,
        "translation": "确定性编排；未调用翻译或生成模型",
    }
