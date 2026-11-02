import json
import math
import os
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .install_backup import copy_rate, database_copy, require_space
from .install_restore_copy import CHECK_MIB_S, HASH_MIB_S, checksum, identity, verify
from .live_read_guard import guard_words
from .live_snapshot import checked_path, fold_wal, read_snapshot
from .snapshot_space import clone_supported

RECORD = "backup-calibration.json"
MAX_AGE = 7 * 86400


def rates(state, size, source):
    defaults = {"copyBps": copy_rate(source), "checkBps": CHECK_MIB_S << 20, "hashBps": HASH_MIB_S << 20, "source": "constants"}
    try:
        record = json.loads((Path(state) / RECORD).read_text())
        if record["host"] != platform.node() or not 0 <= time.time() - record["at"] <= MAX_AGE or not 0.75 <= size / record["bytes"] <= 1.25:
            return defaults
        for key in ("copyBps", "checkBps", "hashBps"):
            if not math.isfinite(record[key]) or record[key] <= 0:
                return defaults
        return {key: record[key] for key in ("copyBps", "checkBps", "hashBps")} | {"source": "host-calibration", "record": str(Path(state) / RECORD), "at": record["at"]}
    except (OSError, ValueError, KeyError, TypeError, ZeroDivisionError):
        return defaults


def calibrate(args):
    source = (Path(args.home).expanduser() / "userdata/statev2.sqlite").resolve()
    state = checked_path(args.state_dir, args.home)
    root = checked_path(args.backups, args.home)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    require_space(root, source.stat().st_size)
    with tempfile.TemporaryDirectory(prefix=".calibrate-", dir=root) as raw:
        scratch = Path(raw) / "statev2.sqlite"
        clone = source.stat().st_dev == root.stat().st_dev and clone_supported(root, root)
        started = time.monotonic()
        if clone:
            read_snapshot(source, scratch, 2, "clone")
        else:
            command = [sys.executable, "-B", "-m", "t3nightly.install_offbox_stage", str(source), str(scratch), *guard_words(2)]
            subprocess.run(command, cwd=Path(__file__).resolve().parent.parent, check=True, capture_output=True, timeout=5)
        live_seconds = time.monotonic() - started
        fold_wal(scratch)
        size = scratch.stat().st_size
        copied = Path(raw) / "copy.sqlite"
        started = time.monotonic()
        database_copy(scratch, copied, started + 3600)
        copy_seconds = time.monotonic() - started
        expected = identity(copied, copy=True)
        started = time.monotonic()
        verify(copied, expected, started + 3600)
        check_seconds = time.monotonic() - started
        started = time.monotonic()
        checksum(copied, started + 3600)
        hash_seconds = time.monotonic() - started
        record = {"host": platform.node(), "at": time.time(), "bytes": size, "method": "clone" if clone else "guarded-copy", "liveReadSeconds": live_seconds, "copySeconds": copy_seconds, "checkSeconds": check_seconds, "hashSeconds": hash_seconds, "copyBps": size / copy_seconds, "checkBps": size / check_seconds, "hashBps": size / hash_seconds}
    with tempfile.NamedTemporaryFile(mode="w", dir=state, delete=False) as output:
        temporary = Path(output.name)
        json.dump(record, output)
    os.replace(temporary, state / RECORD)
    print(json.dumps({"step": "backup-calibrated", "record": str(state / RECORD), "scratchRemoved": not Path(raw).exists(), **record}))
