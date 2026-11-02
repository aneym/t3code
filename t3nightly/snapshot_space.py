import json
import shutil
import subprocess
import tempfile
from pathlib import Path

MARGIN = 1024**3
BACKUP_MIB_S = 16
CONSERVATIVE_MIB_S = 8


def database_bytes(source):
    return sum(path.stat().st_size for path in (Path(source), Path(str(source) + "-wal")) if path.exists())


def backup_seconds(size):
    return min(7200, 30 + size / (CONSERVATIVE_MIB_S * 1024**2))


def clone_supported(source_directory, destination_directory):
    from .live_snapshot import clone_file

    with tempfile.TemporaryDirectory(prefix=".clone-probe-", dir=source_directory) as raw, tempfile.TemporaryDirectory(prefix=".clone-probe-", dir=destination_directory) as out:
        source = Path(raw) / "probe"
        source.write_bytes(b"snapshot capability probe" * 256)
        try:
            clone_file(source, Path(out) / "probe", 2)
            return True
        except (OSError, subprocess.SubprocessError):
            return False


def space_plan(directory, size, *, copies=1, clone=False, margin=MARGIN):
    free = shutil.disk_usage(directory).free
    written = 0 if clone else size * copies
    return {"directory": str(directory), "sourceBytes": size, "copies": copies, "clone": clone, "writeBytes": written, "marginBytes": margin, "requiredBytes": written + margin, "freeBytes": free, "passes": free >= written + margin}


def require_space(directory, size, *, copies=1, clone=False, margin=MARGIN):
    plan = space_plan(directory, size, copies=copies, clone=clone, margin=margin)
    if not plan["passes"]:
        raise ValueError("snapshot space refused; nothing stopped: " + json.dumps(plan))
    return plan["freeBytes"]


def install_plan(source, staging, snapshots, backups, *, offbox_stage=None, stage_floor=60 * 1024**3):
    size = database_bytes(source)
    if offbox_stage is not None:
        return [space_plan(snapshots, size, copies=0), space_plan(offbox_stage, size, margin=stage_floor)]
    source_clone = clone_supported(staging, staging)
    publication_clone = source_clone and Path(staging).stat().st_dev == Path(snapshots).stat().st_dev
    backup_clone = clone_supported(snapshots, backups)
    writes = [(staging, 0), (snapshots, 0 if publication_clone else size), (backups, 0 if backup_clone else size)]
    volumes = {}
    for directory, written in writes:
        device = Path(directory).stat().st_dev
        if device not in volumes:
            volumes[device] = space_plan(directory, size, copies=0)
        row = volumes[device]
        row["copies"] += int(written > 0)
        row["writeBytes"] += written
        row["requiredBytes"] = row["writeBytes"] + MARGIN
        row["passes"] = row["freeBytes"] >= row["requiredBytes"]
    return list(volumes.values())


def require_install_space(source, staging, snapshots, backups):
    plans = install_plan(source, staging, snapshots, backups)
    if any(not row["passes"] for row in plans):
        raise ValueError("snapshot install space refused; nothing stopped: " + json.dumps(plans))
    return plans
