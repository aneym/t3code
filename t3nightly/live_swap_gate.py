import argparse
import json
import os
import time
from pathlib import Path

from .rehearsal_waiter import identity


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--deadline", type=float, required=True)
    parser.add_argument("--slice-s", type=float, default=480)
    args = parser.parse_args()
    run = args.run.resolve()
    if not run.name.startswith("live-swap-") or not (run / "job.json").is_file():
        raise ValueError("live recorder gate requires its recorded run directory")
    pid = os.getpid()
    path = run / f"gate-{pid}.json"
    value = {"pid": pid, "identity": identity(pid), "deadline": args.deadline}
    path.write_text(json.dumps(value) + "\n")
    end = min(args.deadline, time.time() + args.slice_s)
    try:
        while run.is_dir() and time.time() < end and not (run / "release-gate").exists():
            time.sleep(0.25)
    finally:
        if run.is_dir():
            path.write_text(json.dumps({**value, "finishedAt": time.time()}) + "\n")
    released = not run.is_dir() or time.time() >= args.deadline or (run / "release-gate").exists()
    print("GATE_RELEASED" if released else "GATE_CONTINUE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
