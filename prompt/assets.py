"""Read saved metadata and existing media URLs; no decoders or tensor imports."""
import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode


def _inside(root, *parts):
    root = Path(root).resolve()
    target = root.joinpath(*map(str, parts)).resolve()
    if target == root or root not in target.parents:
        raise ValueError("素材路径超出库范围。")
    return target


def _json(path):
    if not path.is_file():
        return {}
    if path.stat().st_size > 8_000_000:
        raise ValueError("素材索引过大。")
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("素材索引格式错误。")
    return value


def _url(root, path, kind):
    if not path or not path.is_file():
        return ""
    relative = path.relative_to(Path(root).resolve())
    return "/view?" + urlencode({"filename": path.name, "subfolder": relative.parent.as_posix(), "type": kind})


def _identity(parts):
    return "asset-" + hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:24]


def read_assets(selectors, roots):
    if not isinstance(selectors, list) or len(selectors) > 300:
        raise ValueError("素材来源数量超出范围。")
    output, errors = [], []
    for selection in selectors:
        try:
            if not isinstance(selection, dict):
                raise ValueError("素材来源格式错误。")
            node_id = str(selection["node_id"])
            kind = selection["kind"]
            label = str(selection.get("node_title", node_id))
            if kind in ("image", "audio"):
                entries = selection.get("entries", [])
                if not isinstance(entries, list) or len(entries) > 100:
                    raise ValueError("参考素材列表格式错误。")
                active_slot = 0
                for raw in entries:
                    entry = {"filename": raw} if isinstance(raw, str) else raw
                    if not isinstance(entry, dict):
                        raise ValueError("参考卡片格式错误。")
                    root_type = entry.get("type", "input")
                    root = roots.get(root_type)
                    if root is None:
                        raise ValueError("不支持的素材路径类型。")
                    filename = entry.get("filename", "")
                    subfolder = entry.get("subfolder", "")
                    path = _inside(root, subfolder, filename)
                    active_slot += not entry.get("skip", False)
                    output.append({
                        "id": _identity([node_id, kind, root_type, str(path)]),
                        "node_id": node_id, "source": label, "kind": kind,
                        "label": entry.get("label") or filename,
                        "filename": filename, "subfolder": subfolder, "type": root_type,
                        "skip": bool(entry.get("skip")), "missing": not path.is_file(),
                        "loader_slot": None if entry.get("skip") else active_slot - 1,
                        "slot": None, "thumbnail_url": _url(root, path, root_type) if kind == "image" else "",
                        "preview_url": _url(root, path, root_type),
                        "start": entry.get("start", 0), "duration": entry.get("duration", 0),
                    })
                continue
            if kind != "video":
                raise ValueError("不支持的素材类型。")
            root = roots["output"]
            legacy = bool(selection.get("legacy"))
            project = str(selection.get("project") or "")
            if not project or project in (".", "..") or "/" in project or "\\" in project:
                raise ValueError("项目名称无效。")
            family = selection["family"]
            if family == "clipstream":
                if str(selection.get("mode", "")).startswith("Force Initial"):
                    continue
                folder = "h3-clipstream" if legacy else "amiaomiao-h3-clips"
                project_path = _inside(root, folder, project)
                index = _json(_inside(project_path, ".bin_index.json"))
                records = index.get("clips", [])
                selected = str(selection.get("selection", "latest"))
                records = [r for r in records if isinstance(r, dict) and r.get("clip_id")]
                want_dual = selection.get("dual", False)
                def matching_kind(record):
                    directory = _inside(project_path, record["clip_id"])
                    single = (directory / "latent.safetensors").is_file()
                    dual = any((directory / f"latent_{variant}.safetensors").is_file()
                               for variant in ("一采", "二采"))
                    return single != dual and dual == bool(want_dual)
                records = [r for r in records if matching_kind(r)]
                if selected.lower() in ("latest", "", "0", "auto", "default"):
                    record = records[0] if records else None
                else:
                    exact = [r for r in records if str(r.get("clip_id")) == selected]
                    matches = exact or [r for r in records if selected in str(r.get("clip_id", ""))
                                        or selected in str(r.get("shot_tag", ""))]
                    if len(matches) > 1:
                        raise ValueError("视频选择匹配多个归档，请选择明确 clip_id。")
                    record = matches[0] if matches else None
                if not record:
                    raise ValueError("未找到所选归档视频。")
                directory = _inside(project_path, record["clip_id"])
                video_name = record.get("video_file") or "video.mp4"
                if want_dual:
                    variants = record.get("variants", {})
                    meta = _json(_inside(directory, "meta.json"))
                    variants = meta.get("variants", variants)
                    video_name = next((variants[v].get("video_file") for v in ("二采", "一采")
                                       if isinstance(variants.get(v), dict) and variants[v].get("video_file")),
                                      "video_一采.mp4")
                video = _inside(directory, video_name) if isinstance(video_name, str) else None
                cover = next((p for p in (_inside(directory, n) for n in
                                         ("preview.png", "tail_frame.png", "first_frame.png")) if p.is_file()), None)
                storage_key = [record["clip_id"], str(video_name)]
                name = record.get("shot_tag") or record["clip_id"]
                file_exists = directory.is_dir()
            else:
                uploads = selection.get("source_mode") == "uploads"
                folder = ("h3-lvm-video-uploads" if legacy else "amiaomiao-h3-video-uploads") if uploads else (
                    "h3-lvm" if legacy else "amiaomiao-h3-segments")
                project_path = _inside(root, folder, project)
                index = _json(_inside(project_path, "h3lvm_upload_index.json" if uploads else "h3lvm_index.json"))
                record = next((r for r in index.get("videos" if uploads else "segments", [])
                               if isinstance(r, dict) and r.get("segment_id") == selection.get("segment_id")), None)
                if not record:
                    raise ValueError("未找到所选视频卡片。")
                directory = _inside(project_path, "files" if uploads else record.get("dir", record.get("tag", "")))
                filename = record.get("storage_name" if uploads else "mp4")
                video = _inside(directory, filename) if filename else None
                thumbnail = record.get("thumbnail")
                cover = _inside(directory, thumbnail) if thumbnail else None
                storage_key = [filename] if uploads else [record.get("dir"), record.get("saved_at")]
                name = record.get("label") or record.get("original_name") or record.get("tag") or str(selection["segment_id"])
                file_exists = video.is_file() if uploads and video else directory.is_dir()
            output.append({
                "id": _identity([node_id, family, folder, project, storage_key]),
                "node_id": node_id, "source": label + " / " + project, "kind": "video",
                "label": str(name), "slot": None, "missing": not file_exists,
                "skip": False, "thumbnail_url": _url(root, cover, "output"),
                "preview_url": _url(root, video, "output"), "project": project,
            })
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            errors.append({"node_id": str(selection.get("node_id", "?")) if isinstance(selection, dict) else "?",
                           "message": str(exc)})
    # A loader can contain the same path twice: collapse identity, never bind by array position.
    seen = {}
    for asset in output:
        if asset["id"] in seen:
            seen[asset["id"]]["slot"] = None
            seen[asset["id"]]["ambiguous"] = True
            errors.append({"node_id": asset["node_id"], "message": "同一来源包含重复路径，请手动确认正式编号。"})
        else:
            seen[asset["id"]] = asset
    return {"assets": list(seen.values()), "errors": errors}
