import argparse
import fcntl
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "t3nightly.build-step/1"


def stamp():
    return datetime.now(timezone.utc).isoformat()


def record(out, step, platform_name, arch, command):
    started = time.monotonic()
    event = {
        "schema": SCHEMA,
        "step": step,
        "platform": platform_name,
        "arch": arch,
        "startedAt": stamp(),
    }
    try:
        code = subprocess.run(command, check=False).returncode
    except OSError:
        code = 127
    event.update({
        "finishedAt": stamp(),
        "durationSeconds": round(time.monotonic() - started, 6),
        "exitCode": code,
        "outcome": "passed" if code == 0 else "failed",
    })
    out.mkdir(parents=True, exist_ok=True)
    with (out / "build-timings.jsonl").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        handle.write(json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n")
        handle.flush()
    return code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--step", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--arch", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required")
    return record(args.out.resolve(), args.step, args.platform, args.arch, command)


if __name__ == "__main__":
    sys.exit(main())
