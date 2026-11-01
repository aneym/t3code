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
    args = parser.parse_args()
    run = args.run.resolve()
    if not run.name.startswith("live-swap-") or not (run / "job.json").is_file():
        raise ValueError("live recorder gate requires its recorded run directory")
    pid = os.getpid()
    path = run / f"gate-{pid}.json"
    value = {"pid": pid, "identity": identity(pid), "deadline": args.deadline}
    path.write_text(json.dumps(value) + "\n")
    try:
        while run.is_dir() and time.time() < args.deadline and not (run / "release-gate").exists():
            time.sleep(0.25)
    finally:
        if run.is_dir():
            path.write_text(json.dumps({**value, "finishedAt": time.time()}) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
