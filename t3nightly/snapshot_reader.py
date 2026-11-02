import argparse
import json
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from . import live_read_guard as guard
from .live_snapshot import clone_file


def capture(source, destination, method, watch):
    started = time.monotonic()
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=0.25, isolation_level=None)) as reader:
        watch.connection = reader
        watch.check()
        if reader.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
            raise ValueError("live snapshot requires WAL mode; nothing stopped")
        reader.execute("BEGIN")
        try:
            reader.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
            if method == "clone":
                for suffix in ("", "-wal"):
                    watch.check()
                    original = Path(str(source) + suffix)
                    if original.exists():
                        clone_file(original, Path(str(destination) + suffix), max(0.001, watch.deadline - time.monotonic()))
            else:
                with closing(sqlite3.connect(destination)) as writer:
                    reader.backup(writer, pages=256, progress=watch.check, sleep=0.05)
            watch.check()
        finally:
            if reader.in_transaction:
                reader.execute("ROLLBACK")
            watch.connection = None
    print(json.dumps({"liveReadSeconds": round(time.monotonic() - started, 6), "walPeakBytes": watch.peak, "method": method}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("method", choices=("clone", "backup"))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    guard.add_guard_arguments(parser)
    args = parser.parse_args()
    with guard.guarded(args.source, args.wal_limit, args.seconds, args.parent) as watch:
        capture(args.source, args.destination, args.method, watch)
