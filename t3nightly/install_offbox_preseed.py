import argparse
import fcntl
import json
import shlex
import sqlite3
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from . import install_offbox as offbox
from .db_publish import wal_bytes
from .install_restore_hold import write

SCHEMA = "t3nightly.offbox-preseed/1"


def now():
    return datetime.now(UTC)


class Preseed:
    def __init__(self, args):
        self.args = args
        self.home = Path(args.home).expanduser()
        self.db = self.home / "userdata" / "statev2.sqlite"
        self.state = Path(args.state_dir).expanduser()
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.steps = []

    def step(self, name, **fields):
        row = {"step": name, "at": now().isoformat(), **fields}
        self.steps.append(row)
        print(json.dumps(row), flush=True)


def discard(host, path):
    quoted = shlex.quote(str(path))
    offbox.remote(host, f"set -e; [ ! -L {quoted} ]; rm -rf -- {quoted}", time.monotonic() + 120)


def ship(run):
    started = time.monotonic()
    host, root, replica, source, size = offbox.placement(run, run.db.resolve().parent)
    run.step("preseed-placement", remote=f"{host}:{replica}", sourceBytes=size, rawShipEstimateSeconds=round(size / offbox.rate(run)))
    seeded, deadline = offbox.preseed(run, host, root, replica, source, size, started)
    return offbox.verified(run, host, root, replica, deadline, {"bytes": size, "seed": seeded, "live": True, "preseed": True, "walBytes": wal_bytes(source)})


def main():
    parser = argparse.ArgumentParser(prog="python3 -m t3nightly.install_offbox_preseed",
                                     description="Ship an off-box rollback replica of the live database ahead of an --offbox install, which clones it and sends only the catch-up delta.")
    parser.add_argument("--offbox", required=True, help="HOST:/path, the same root the install's --offbox names")
    parser.add_argument("--offbox-stage", required=True, help="stage directory; the preseed stages in its preseed/ subdirectory")
    parser.add_argument("--offbox-stage-floor-gib", type=int, default=60)
    parser.add_argument("--offbox-mib-s", type=float, default=0.5)
    parser.add_argument("--offbox-seed-s", type=int, default=43200)
    parser.add_argument("--offbox-copy-s", type=int, default=600)
    parser.add_argument("--home", default="~/.t3")
    parser.add_argument("--state-dir", default="~/.t3nightly/offbox-preseed")
    parser.add_argument("--receipt", type=Path, help="defaults to STATE_DIR/preseed-<utc>.json")
    args = parser.parse_args()
    if args.offbox_mib_s <= 0 or args.offbox_seed_s < 60 or args.offbox_stage_floor_gib < 0 or args.offbox_copy_s < 10:
        parser.error("--offbox-mib-s must be positive, --offbox-seed-s at least 60, --offbox-stage-floor-gib non-negative and --offbox-copy-s at least 10")
    started = now()
    args.version = f"preseed-{started.strftime('%Y%m%dT%H%M%SZ')}"
    args.offbox_stage = str(Path(args.offbox_stage).expanduser().absolute() / "preseed")
    run = Preseed(args)
    receipt = (args.receipt or run.state / f"{args.version}.json").expanduser()
    result = {"schema": SCHEMA, "name": args.version, "home": str(run.home), "offbox": args.offbox, "stage": args.offbox_stage, "startedAt": started.isoformat()}
    try:
        host, root = offbox.target(args.offbox)
    except ValueError as error:
        parser.error(str(error))
    with (run.state / "preseed.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "another off-box preseed is running\n")
        try:
            result.update(outcome="verified", backup=ship(run))
        except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
            result.update(outcome="failed", error=f"{type(error).__name__}: {error}")
            try:
                discard(host, root / args.version)
                result["discarded"] = f"{host}:{root / args.version}"
            except (OSError, ValueError, subprocess.SubprocessError) as cleanup:
                result["discardError"] = str(cleanup)
    result.update(finishedAt=now().isoformat(), steps=run.steps)
    receipt.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    write(receipt, result)
    print(json.dumps({"outcome": result["outcome"], "receipt": str(receipt), "remote": result.get("backup", {}).get("remote")}), flush=True)
    return 0 if result["outcome"] == "verified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
