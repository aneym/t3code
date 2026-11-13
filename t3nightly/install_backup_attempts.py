import json
import os
import shutil
import time
import uuid
from pathlib import Path

from .install_storage import backup_roots

MARKER = ".t3nightly-attempt.json"
SCHEMA = "t3nightly.backup-attempt/1"
RECEIPTS = ("payload.json", "at-stop.json")


def roots(run):
    return [*backup_roots(run.home, run.backups), run.home.absolute() / "runtime" / "rollback"]


def create(run, root):
    destination = Path(root) / uuid.uuid4().hex
    destination.mkdir(mode=0o700)
    marker = destination / MARKER
    marker.write_text(json.dumps({"schema": SCHEMA, "home": str(run.home.resolve()), "pid": os.getpid(), "createdNs": time.time_ns()}) + "\n")
    marker.chmod(0o600)
    if isinstance(getattr(run, "backup_attempt_directories", None), list):
        run.backup_attempt_directories.append(destination)
    return destination


def completed(destination):
    (Path(destination) / MARKER).unlink(missing_ok=True)


def discard(destination):
    completed(destination)
    Path(destination).rmdir()


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def owned(directory, home):
    marker = directory / MARKER
    if directory.is_symlink() or not directory.is_dir() or marker.is_symlink() or not marker.is_file():
        return None
    try:
        value = json.loads(marker.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or value.get("schema") != SCHEMA or value.get("home") != home or type(value.get("pid")) is not int:
        return None
    return value


def sweep(run):
    home = str(run.home.resolve())
    result = {"removed": [], "unmarked": []}
    for root in roots(run):
        if root.is_symlink() or not root.is_dir():
            continue
        for directory in sorted(root.iterdir()):
            value = owned(directory, home)
            if value is None:
                continue
            if alive(value["pid"]):
                continue
            if any((directory / name).exists() for name in RECEIPTS):
                completed(directory)
                result["unmarked"].append(str(directory))
                continue
            shutil.rmtree(directory)
            result["removed"].append(str(directory))
    if result["removed"] or result["unmarked"]:
        run.step("backup-attempt-sweep", removed=result["removed"], unmarked=result["unmarked"])
    return result


def start(run):
    try:
        return sweep(run)
    except OSError as error:
        run.step("backup-attempt-sweep", error=f"{type(error).__name__}: {error}")
        return None
