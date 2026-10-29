import json
import os
import re
import stat
import time
from pathlib import Path

ROOT = Path.home() / ".t3nightly" / "previews"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def validate_name(value):
    if not NAME.fullmatch(value):
        raise ValueError("preview name must contain only letters, numbers, dot, underscore or hyphen")
    return value


def preview_dir(name):
    validate_name(name)
    return ROOT / name


def ensure_root():
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(ROOT, 0o700)


def write_private(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(data)
    os.chmod(path, 0o600)


def read_state(name):
    path = preview_dir(name) / "state.json"
    try:
        with path.open() as handle:
            state = json.load(handle)
    except (OSError, ValueError) as exc:
        raise ValueError("cannot read preview state for %s: %s" % (name, exc)) from exc
    if not isinstance(state, dict):
        raise ValueError("preview state for %s is not an object" % name)
    if not isinstance(state.get("worktree"), str) or not state["worktree"]:
        raise ValueError("preview state for %s has no worktree" % name)
    if state.get("name") != name:
        raise ValueError("preview state for %s has an invalid name" % name)
    try:
        float(state["start"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("preview state for %s has an invalid start" % name) from exc
    return state


def save_state(name, state):
    ensure_root()
    directory = preview_dir(name)
    pending = directory / ("state-%d.tmp" % os.getpid())
    try:
        write_private(pending, json.dumps(state, sort_keys=True) + "\n")
        pending.replace(directory / "state.json")
    finally:
        pending.unlink(missing_ok=True)


def new_state(name, worktree, sha, pushed_at, pid, pgid, process_start, started):
    return {
        "name": name,
        "worktree": str(worktree),
        "sha": sha,
        "pushed_at": pushed_at,
        "pid": pid,
        "pgid": pgid,
        "process_start": process_start,
        "start": started,
        "status": "starting",
    }


def age_seconds(start):
    return max(0, int(time.time() - float(start)))


def mode(path):
    return stat.S_IMODE(path.stat().st_mode)
