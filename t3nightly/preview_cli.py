import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from .preview_identity import live_identity, refuse_listener, stop_recorded
from .preview_process import require_sandbox_data, start_server, wait_setup
from .preview_state import ROOT, age_seconds, ensure_root, new_state, preview_dir, read_state, save_state

ALLOWED = Path("/Volumes/StudioExt/repos/t3code-wt").resolve()


def checked_worktree(value):
    path = Path(value).expanduser().resolve()
    if path == Path("/Volumes/StudioExt/repos/t3code").resolve() or ALLOWED not in path.parents:
        raise ValueError("worktree must be under /Volumes/StudioExt/repos/t3code-wt")
    if not path.is_dir():
        raise ValueError("worktree does not exist")
    marker = path / ".git"
    if not marker.is_file() or marker.is_symlink():
        raise ValueError("worktree .git must be a linked-worktree file")
    value = marker.read_text().strip()
    if not value.startswith("gitdir:"):
        raise ValueError("invalid linked-worktree .git file")
    gitdir = (path / value[7:].strip()).resolve()
    allowed_gitdir = Path("/Volumes/StudioExt/repos/t3code/.git/worktrees").resolve()
    if gitdir.parent != allowed_gitdir or not gitdir.is_dir():
        raise ValueError("worktree gitdir must belong to t3code/.git/worktrees")
    if (gitdir / "gitdir").read_text().strip() != str(marker):
        raise ValueError("linked-worktree gitdir does not point back to this worktree")
    return path


def git(worktree, *words):
    result = subprocess.run(["git", "-C", str(worktree), *words], check=False, capture_output=True, text=True)
    if result.returncode:
        raise ValueError("git command failed: %s" % " ".join(words))
    return result.stdout.strip()


def pushed_at(worktree):
    branch = git(worktree, "branch", "--show-current")
    if not branch:
        return None
    result = subprocess.run(
        ["git", "-C", str(worktree), "show", "-s", "--format=%cI", "origin/%s" % branch],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def start(args):
    worktree = checked_worktree(args.worktree)
    name = args.name
    directory = preview_dir(name)
    if (directory / "state.json").exists():
        if alive(read_state(name)):
            raise ValueError("preview name is already in use")
    for entry in ROOT.iterdir():
        if entry.is_dir() and (entry / "state.json").exists():
            try:
                other = read_state(entry.name)
            except ValueError as exc:
                print(str(exc), file=sys.stderr)
                continue
            if Path(other["worktree"]).resolve() == worktree and alive(other):
                raise ValueError("a live preview already uses this worktree")
    refuse_listener(worktree)
    ensure_root()
    sha = git(worktree, "rev-parse", "HEAD")
    started = time.time()
    state = new_state(name, worktree, sha, pushed_at(worktree), None, None, None, started)
    save_state(name, state)
    log = directory / "preview.log"
    proc = None
    process_started = None
    pgid = None
    pairing_path = directory / "pairing-url"

    def record_process(process, identity, group):
        state.update({"pid": process.pid, "pgid": group, "process_start": identity})
        save_state(name, state)

    try:
        os.chmod(directory, 0o700)
        log.touch(mode=0o600, exist_ok=True)
        os.chmod(log, 0o600)
        require_sandbox_data(worktree)
        wait_setup(worktree, log)
        proc, process_started, pgid, origin = start_server(worktree, log, pairing_path, record_process)
        ready = time.time()
        state.update({"status": "running", "origin": origin, "preview_ready_at": ready, "seconds": round(ready - started, 3)})
        save_state(name, state)
        row = {
            "name": name,
            "worktree": str(worktree),
            "sha": sha,
            "pushed_at": state["pushed_at"],
            "start": started,
            "preview_ready_at": ready,
            "seconds": round(ready - started, 3),
            "origin": origin,
        }
        timeline = Path.home() / ".t3nightly" / "previews" / "timeline.jsonl"
        with timeline.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, sort_keys=True) + "\n")
        print(origin)
    except BaseException:
        if proc:
            try:
                stop_recorded(proc.pid, pgid, process_started, worktree)
                proc.wait(timeout=20)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
        pairing_path.unlink(missing_ok=True)
        if state:
            state["status"] = "failed"
            try:
                save_state(name, state)
            except OSError:
                pass
        raise


def stop(args):
    state = read_state(args.name)
    worktree = Path(state["worktree"]).resolve()
    if live_identity(state) is not None:
        stop_recorded(int(state["pid"]), int(state["pgid"]), state["process_start"], worktree)
    (preview_dir(args.name) / "pairing-url").unlink(missing_ok=True)
    state.update({"status": "stopped", "stopped": time.time()})
    save_state(args.name, state)


def alive(state):
    if state.get("status") not in ("starting", "running"):
        return False
    try:
        return live_identity(state) is not None
    except (OSError, ValueError):
        return False


def list_previews(_args):
    ensure_root()
    for directory in sorted(ROOT.iterdir()):
        if not directory.is_dir() or not (directory / "state.json").exists():
            continue
        try:
            state = read_state(directory.name)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            continue
        print("%s\t%s\t%s\t%s\t%ss\t%s" % (
            state["name"], state["worktree"], state.get("sha", ""), state.get("origin", ""),
            age_seconds(state.get("start", time.time())), "alive" if alive(state) else "stopped",
        ))


def reap(args):
    ensure_root()
    cutoff = args.older_than_h * 3600
    for directory in sorted(ROOT.iterdir()):
        if not directory.is_dir() or not (directory / "state.json").exists():
            continue
        try:
            state = read_state(directory.name)
            if state.get("status") != "stopped" and age_seconds(state["start"]) >= cutoff:
                stop(argparse.Namespace(name=directory.name))
        except (OSError, ValueError, RuntimeError, KeyError, TypeError) as exc:
            print("%s: %s" % (directory.name, exc), file=sys.stderr)


def parser():
    root = argparse.ArgumentParser(prog="preview")
    sub = root.add_subparsers(dest="command", required=True)
    start_parser = sub.add_parser("start")
    start_parser.add_argument("worktree")
    start_parser.add_argument("--name", required=True)
    stop_parser = sub.add_parser("stop")
    stop_parser.add_argument("name")
    sub.add_parser("list")
    reap_parser = sub.add_parser("reap")
    reap_parser.add_argument("--older-than-h", type=float, default=24)
    return root


def terminate(signum, _frame):
    signal.signal(signum, signal.SIG_IGN)
    raise SystemExit(128 + signum)


def main(argv=None):
    signal.signal(signal.SIGTERM, terminate)
    args = parser().parse_args(argv)
    ensure_root()
    with (ROOT / ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("another preview command is in progress") from None
        if args.command == "start":
            start(args)
        elif args.command == "stop":
            stop(args)
        elif args.command == "list":
            list_previews(args)
        elif args.command == "reap":
            reap(args)
    return 0
