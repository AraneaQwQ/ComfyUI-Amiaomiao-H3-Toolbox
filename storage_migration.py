"""Import legacy libraries once per project, preserving original media paths."""
import json
import logging
import os
from pathlib import Path
import shutil
import stat
import tempfile
import threading
import time

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_startup_lock = threading.Lock()
_startup_thread = None
STATE_NAME = ".amiaomiao-h3-migration-v1.json"
LIBRARIES = (
    ("h3-clipstream", "amiaomiao-h3-clips"),
    ("minimax_h3_bins", "amiaomiao-h3-clips"),
    ("h3-lvm", "amiaomiao-h3-segments"),
    ("h3-lvm-video-uploads", "amiaomiao-h3-video-uploads"),
)
REF_LIBRARIES = ("h3-lvm-image-refs", "h3-lvm-audio-refs")


def _linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def _projects(output):
    for old, new in LIBRARIES:
        source = output / old
        if not source.is_dir() or _linked(source):
            continue
        for project in sorted(source.iterdir()):
            if project.name.startswith(".") or not project.is_dir():
                continue
            if _linked(project):
                logger.warning("[H3 Toolbox] Linked legacy project skipped: %s", project)
                continue
            if old == "h3-lvm" and project.name in REF_LIBRARIES:
                for ref_project in sorted(project.iterdir()):
                    if ref_project.is_dir() and not ref_project.name.startswith("."):
                        yield ref_project, output / new / project.name / ref_project.name
            else:
                yield project, output / new / project.name


def _copy_project(source, destination):
    # Check and copy in one traversal; never follow links into another library.
    if _linked(source):
        raise ValueError("Linked library entry: " + str(source))
    if source.is_dir():
        destination.mkdir()
        with os.scandir(source) as entries:
            for entry in entries:
                _copy_project(Path(entry.path), destination / entry.name)
        shutil.copystat(source, destination)
    else:
        shutil.copy2(source, destination)


def _save_state(path, completed):
    handle, name = tempfile.mkstemp(prefix=".h3-migration-", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump({"version": 1, "completed": sorted(completed)}, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def migrate_legacy_storage(output):
    """Copy missing projects; never merge indexes or resurrect imported deletions.

    Reference presets intentionally retain their original {type, subfolder, filename}.
    ComfyUI resolves those paths directly, so existing input media needs no copying.
    """
    output = Path(output)
    report = {"copied": [], "conflicts": [], "errors": []}
    with _lock:
        if not output.is_dir():
            return report
        state_path = output / STATE_NAME
        try:
            state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
            if state and (state.get("version") != 1 or not isinstance(state.get("completed"), list)
                          or not all(isinstance(item, str) for item in state["completed"])):
                raise ValueError("Invalid migration state")
            completed = set(state.get("completed", []))
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            report["errors"].append(str(exc))
            logger.warning("[H3 Toolbox] Migration state unreadable; import skipped: %s", exc)
            return report
        try:
            projects = list(_projects(output))
        except OSError as exc:
            report["errors"].append(str(exc))
            logger.warning("[H3 Toolbox] Cannot inspect legacy libraries: %s", exc)
            return report
        for source, target in projects:
            key = source.relative_to(output).as_posix()
            if key in completed:
                continue
            if target.exists() or target.is_symlink():
                report["conflicts"].append(key)
                logger.warning("[H3 Toolbox] Legacy project %s skipped: destination exists (%s)",
                               key, target)
                continue
            stage = None
            try:
                started = time.monotonic()
                logger.info("[H3 Toolbox] Importing %s in background; large media may take time", key)
                # Validate target ancestors before writing into an existing library.
                for parent in [target.parent, *target.parent.parents]:
                    if parent == output:
                        break
                    if parent.exists() and _linked(parent):
                        raise ValueError("Linked destination: " + str(parent))
                target.parent.mkdir(parents=True, exist_ok=True)
                stage = Path(tempfile.mkdtemp(prefix=".h3-import-", dir=target.parent))
                _copy_project(source, stage / "project")
                if target.exists() or target.is_symlink():
                    raise FileExistsError("Destination created during import: " + str(target))
                os.rename(stage / "project", target)
                completed.add(key)
                _save_state(state_path, completed)
                report["copied"].append(key)
                logger.info("[H3 Toolbox] Imported legacy project %s (%.2fs)",
                            key, time.monotonic() - started)
            except (OSError, ValueError) as exc:
                report["errors"].append(key + ": " + str(exc))
                logger.warning("[H3 Toolbox] Legacy import failed for %s: %s", key, exc)
            finally:
                if stage is not None:
                    shutil.rmtree(stage, ignore_errors=True)
    return report


def _startup_worker():
    started = time.monotonic()
    try:
        import folder_paths
        report = migrate_legacy_storage(folder_paths.get_output_directory())
        logger.info("[H3 Toolbox] Legacy import finished in %.2fs: %d imported, %d conflicts, "
                    "%d errors. Refresh library menus to see imported projects.",
                    time.monotonic() - started, len(report["copied"]),
                    len(report["conflicts"]), len(report["errors"]))
    except Exception:
        logger.exception("[H3 Toolbox] Legacy import skipped; Toolbox will still load")


def migrate_on_startup():
    """Schedule once per process; library copying must not block server startup."""
    global _startup_thread
    with _startup_lock:
        if _startup_thread is None:
            logger.info("[H3 Toolbox] Checking legacy libraries in background")
            worker = threading.Thread(target=_startup_worker, name="H3ToolboxLegacyImport", daemon=True)
            worker.start()
            _startup_thread = worker
        return _startup_thread
