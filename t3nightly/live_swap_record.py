import argparse
import json
import os
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


def moment(value):
    if value == "now":
        return time.time()
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("recording timestamps require a timezone")
    return parsed.timestamp()


def main():
    parser = argparse.ArgumentParser(description="Detach a live EnvironmentSupervisor HTTP/WS swap recording; never restarts the service.")
    parser.add_argument("--host", default=platform.node().split(".")[0].lower())
    parser.add_argument("--home", type=Path, default=Path.home() / ".t3")
    parser.add_argument("--port", type=int, default=3773)
    parser.add_argument("--rpc-tree", type=Path, required=True)
    parser.add_argument("--start", default="now")
    parser.add_argument("--until")
    parser.add_argument("--duration-s", type=int, default=900)
    parser.add_argument("--thread", default="", help="observer mode: read-only WS/HTTP client on this thread; holds no T3 turn or run")
    parser.add_argument("--turn", action="store_true", help="one Haiku turn in registered ~/.t3/scratch, held until swap or final minute")
    parser.add_argument("--provider", choices=("claude",), default="claude")
    parser.add_argument("--model", default="claude-haiku-4-5")
    parser.add_argument("--run-dir", type=Path)
    args = parser.parse_args()
    start = moment(args.start)
    until = moment(args.until) if args.until else start + args.duration_s
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.host) or not 60 <= until - start <= 7200 or start > time.time() + 86400 or until <= time.time():
        parser.error("host must be a safe label; recording duration 60..7200s, starting within 24h and ending in future")
    if not args.turn and not args.thread:
        parser.error("supply --thread for read-only recording or --turn for one real scratch turn")
    if args.turn and args.thread:
        parser.error("--turn creates its own single scratch thread; do not combine with --thread")
    if args.model != "claude-haiku-4-5":
        parser.error("recorder turns use Claude Haiku only")
    tree = args.rpc_tree.expanduser().resolve()
    if not (tree / "packages/client-runtime/src/connection/supervisor.ts").is_file():
        parser.error("--rpc-tree requires production client-runtime source and installed dependencies")
    stamp = datetime.fromtimestamp(start, timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run = (args.run_dir or Path.home() / ".agent-rails/lanes/t3-hot-swap-cutover/proof" / f"live-swap-{args.host}-{stamp}").expanduser().absolute()
    if not run.name.startswith("live-swap-") or run.exists():
        parser.error("run directory must be a new live-swap-* directory")
    protected = (Path.home() / ".t3/userdata").resolve()
    if run.resolve() == protected or run.resolve().is_relative_to(protected):
        parser.error("recorder output cannot be inside live userdata")
    if sys.platform == "darwin" and (str(run.resolve()).startswith("/Volumes/") or str(tree).startswith("/Volumes/")):
        parser.error("Studio recorder run and RPC tree must be internal storage")
    run.mkdir(parents=True, mode=0o700)
    engine = run / "engine/t3nightly"
    shutil.copytree(Path(__file__).parent, engine, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    label = "com.agent-rails.t3-live-swap-" + uuid.uuid4().hex[:16]
    job = {"host": args.host, "home": str(args.home.expanduser().resolve()), "port": args.port, "rpcTree": str(tree), "start": start, "until": until, "hardDeadline": until + 90, "settleSeconds": 60, "turn": args.turn, "thread": args.thread, "provider": args.provider, "model": args.model, "label": label}
    (run / "job.json").write_text(json.dumps(job, indent=2) + "\n")
    command = [sys.executable, "-m", "t3nightly.live_swap_worker", str(run)]
    log = str(run / "job.log")
    environment = {"HOME": str(Path.home()), "PATH": os.pathsep.join(p for p in os.environ.get("PATH", "/usr/bin:/bin").split(os.pathsep) if not str(Path(p).resolve()).startswith("/Volumes/"))}
    if sys.platform == "darwin":
        unit = {"Label": label, "ProgramArguments": command, "RunAtLoad": True, "WorkingDirectory": str(engine.parent), "StandardOutPath": log, "StandardErrorPath": log, "EnvironmentVariables": environment, "ExitTimeOut": 20, "ProcessType": "Interactive"}
        plist = run / "recorder.plist"
        plist.write_bytes(plistlib.dumps(unit))
        invocation = ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist)]
    elif sys.platform == "linux":
        invocation = ["systemd-run", "--user", "--collect", f"--unit={label}", "--property=Type=exec", f"--property=WorkingDirectory={engine.parent}", f"--property=RuntimeMaxSec={max(1, int(until + 95 - time.time()))}", f"--property=StandardOutput=append:{log}", f"--property=StandardError=append:{log}", "--", *command]
    else:
        parser.error("detached recorder requires launchd or systemd-user")
    from .live_swap_cleanup import start_watcher

    result = subprocess.run(invocation, capture_output=True, timeout=30)
    if result.returncode:
        raise ValueError("detached submission failed; inspect recorded job, do not replay blindly")
    start_watcher(run, engine.parent)
    print(json.dumps({"label": label, "run": str(run), "start": start, "until": until, "hardDeadline": job["hardDeadline"], "detached": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
