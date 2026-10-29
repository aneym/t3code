import hashlib
import json
import os
import platform
import re
import socket
import sqlite3
import subprocess
import time
import urllib.request
from pathlib import Path

from .gate_proc import CheckFailed, Deadline, clean_env, run, spawn, stop_group
from .gate_seed import CACHE_ROOT, populate_home

LIVE_HOME = Path.home() / ".t3"
QUIET_SETTINGS = {
    "sidebarAutoSettleAfterDays": None,
    "sidebarAutoSettleOnMerge": False,
    "continueThreadsAfterServerUpdate": False,
    "autoResumeLimitedThreads": False,
    "idleCompaction": "off",
}


def resolve_node(tree):
    pinned = os.environ.get("T3NIGHTLY_NODE")
    if pinned:
        return pinned
    match = re.search(
        r'"node":\s*"([0-9.]+)"', (Path(tree) / "package.json").read_text()
    )
    if match:
        candidate = (
            Path.home() / ".vite-plus/js_runtime/node" / match.group(1) / "bin/node"
        )
        if candidate.exists():
            return str(candidate)
    return "node"


def unpack(archive, work):
    source = Path(archive)
    if source.is_dir():
        return source
    target = work / "runtime"
    target.mkdir()
    subprocess.run(
        ["tar", "-xzf", str(source), "-C", str(target)],
        check=True,
        capture_output=True,
        timeout=300,
    )
    roots = [path for path in target.iterdir() if path.is_dir()]
    if len(roots) != 1 or not (roots[0] / "t3").exists():
        raise CheckFailed("archive does not hold one root with a t3 executable")
    return roots[0]


def guard_isolated(home):
    live = LIVE_HOME.resolve()
    resolved = Path(home).resolve()
    if resolved == live or live in resolved.parents:
        raise CheckFailed("refusing to use the live T3 home %s" % live)


def snapshot_live_db(dest, deadline):
    live = LIVE_HOME / "userdata" / "statev2.sqlite"
    if not live.exists():
        raise CheckFailed("no live database at %s to seed from" % live)
    source = sqlite3.connect("file:%s?mode=ro" % live, uri=True, timeout=30)
    target = sqlite3.connect(str(dest))
    try:
        source.execute("BEGIN")
        source.execute("SELECT rootpage FROM sqlite_schema LIMIT 1").fetchone()
        source.backup(target, pages=1024, progress=lambda *_: deadline.left())
    finally:
        target.close()
        source.close()
    return live.stat().st_size


def build_seed(ctx, home, deadline):
    guard_isolated(home)
    snapshot = home.parent / "live-snapshot.sqlite"
    try:
        live_bytes = snapshot_live_db(snapshot, deadline)
        code, _ = run(
            [
                ctx.node,
                "scripts/migrate-dev-db.ts",
                "--base-dir",
                str(home),
                "--source",
                str(snapshot),
                "--projects",
                "3",
                "--threads-per-project",
                "5",
            ],
            ctx.log("boot"),
            deadline,
            cwd=str(Path(ctx.tree) / "apps/server"),
        )
    finally:
        snapshot.unlink(missing_ok=True)
        for suffix in ("-wal", "-shm"):
            Path(str(snapshot) + suffix).unlink(missing_ok=True)
    if code != 0:
        raise CheckFailed("migrate-dev-db exited %d" % code)
    return live_bytes


def seed_home(ctx, deadline):
    guard_isolated(ctx.home)
    guard_isolated(CACHE_ROOT)
    boot_remaining = deadline.left()
    live_bytes = populate_home(ctx, Deadline(30 * 60), build_seed)
    (Path(ctx.home) / "userdata" / "settings.json").write_text(
        json.dumps(QUIET_SETTINGS, indent=2) + "\n"
    )
    deadline.end = time.monotonic() + boot_remaining
    return live_bytes


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def http_json(url, timeout=3):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.status, response.read()


def start_server(ctx, deadline):
    guard_isolated(ctx.home)
    ctx.port = free_port()
    ctx.origin = "http://127.0.0.1:%d" % ctx.port
    ctx.server = spawn(
        [
            ctx.t3,
            "serve",
            "--base-dir",
            str(ctx.home),
            "--host",
            "127.0.0.1",
            "--port",
            str(ctx.port),
            "--no-browser",
            str(ctx.project),
        ],
        ctx.log("server"),
        cwd=str(ctx.project),
    )
    while True:
        if ctx.server.poll() is not None:
            raise CheckFailed("server exited %d during startup" % ctx.server.returncode)
        try:
            status, _ = http_json(ctx.origin + "/", timeout=2)
            if status == 200:
                break
        except OSError:
            pass
        deadline.left()
        time.sleep(0.5)
    _, body = http_json(ctx.origin + "/.well-known/t3/environment")
    return json.loads(body)


def owned_slice(home):
    state_dir = str(Path(home) / "userdata")
    return (
        "app-t3code-agents-%s.slice"
        % hashlib.sha256(state_dir.encode()).hexdigest()[:12]
    )


def stop_server(ctx):
    notes: list[str] = []
    stopped = True
    if ctx.server is not None:
        stopped = stop_group(ctx.server, grace=20)
        notes.append("server %s" % ("stopped" if stopped else "did not stop"))
    if platform.system() == "Linux" and ctx.home is not None:
        unit = owned_slice(ctx.home)
        result = subprocess.run(
            ["systemctl", "--user", "stop", unit],
            capture_output=True,
            timeout=60,
            env=clean_env(),
            check=False,
        )
        notes.append("slice %s stop exit %d" % (unit, result.returncode))
    return stopped, notes


def make_project(path):
    path.mkdir()
    (path / "README.md").write_text("t3 nightly gate scratch project\n")
    env = clean_env(
        {
            "GIT_AUTHOR_NAME": "t3nightly",
            "GIT_AUTHOR_EMAIL": "gate@t3nightly.invalid",
            "GIT_COMMITTER_NAME": "t3nightly",
            "GIT_COMMITTER_EMAIL": "gate@t3nightly.invalid",
        }
    )
    for cmd in (
        ["git", "init", "-q"],
        ["git", "add", "."],
        ["git", "commit", "-qm", "init"],
    ):
        subprocess.run(
            cmd, cwd=path, check=True, env=env, capture_output=True, timeout=30
        )
