import json
import math
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .db_publish import fsync
from .install_database_copy import copy_rate, database_copy
from .install_restore_copy import CHECK_MIB_S, HASH_MIB_S, checksum, identity, verify
from .live_read_guard import guard_words
from .live_snapshot import checked_path, fold_wal, read_snapshot
from .snapshot_space import clone_supported, database_bytes, require_space

RECORD = "backup-calibration.json"
MAX_AGE = 7 * 86400
MAX_BPS = 20 << 30


def rates(state, size, source, *, root, clone):
    defaults = {"copyBps": copy_rate(source), "checkBps": CHECK_MIB_S << 20, "hashBps": HASH_MIB_S << 20, "source": "constants"}
    try:
        record = json.loads((Path(state) / RECORD).read_text())
        if record["host"] != platform.node() or not 0 <= time.time() - record["at"] <= MAX_AGE or not 0.75 <= size / record["bytes"] <= 1.25:
            return defaults
        if record["volumeDevice"] != Path(root).stat().st_dev or record["method"] != ("clone" if clone else "guarded-copy"):
            return defaults
        for key in ("copyBps", "checkBps", "hashBps"):
            if not math.isfinite(record[key]) or not 0 < record[key] <= MAX_BPS:
                return defaults
        return {key: record[key] for key in ("copyBps", "checkBps", "hashBps")} | {"source": "host-calibration", "record": str(Path(state) / RECORD), "at": record["at"]}
    except (OSError, ValueError, KeyError, TypeError, ZeroDivisionError, OverflowError):
        return defaults


def calibrate(args):
    source = (Path(args.home).expanduser() / "userdata/statev2.sqlite").resolve()
    state = checked_path(args.state_dir, args.home)
    root = checked_path(args.backups, args.home)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    size = database_bytes(source)
    clone = False
    if sys.platform == "darwin":
        clone_root = checked_path(Path(args.home).expanduser() / "runtime/rollback-backups", args.home)
        clone_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if source.stat().st_dev == clone_root.stat().st_dev and shutil.disk_usage(clone_root).free >= size * 3 and clone_supported(clone_root, clone_root):
            root, clone = clone_root, True
    require_space(root, size, copies=0 if clone else 2, margin=max(size // 10, 512 << 20))
    with tempfile.TemporaryDirectory(prefix=".calibrate-", dir=root) as raw:
        scratch = Path(raw) / "statev2.sqlite"
        started = time.monotonic()
        if clone:
            read_snapshot(source, scratch, 2, "clone")
        else:
            command = [sys.executable, "-B", "-m", "t3nightly.install_offbox_stage", str(source), str(scratch), *guard_words(2)]
            subprocess.run(command, cwd=Path(__file__).resolve().parent.parent, check=True, capture_output=True, timeout=5)
        live_seconds = time.monotonic() - started
        fold_wal(scratch)
        size = scratch.stat().st_size
        copied = scratch
        copy_seconds = None
        copy_bps = copy_rate(source)
        if not clone:
            require_space(root, size, margin=max(size // 10, 512 << 20))
            copied = Path(raw) / "copy.sqlite"
            started = time.monotonic()
            database_copy(scratch, copied, started + 3600)
            copy_seconds = time.monotonic() - started
            copy_bps = size / copy_seconds
        expected = identity(copied, copy=True)
        started = time.monotonic()
        verify(copied, expected, started + 3600)
        check_seconds = time.monotonic() - started
        started = time.monotonic()
        checksum(copied, started + 3600)
        hash_seconds = time.monotonic() - started
        record = {"host": platform.node(), "at": time.time(), "bytes": size, "volumeDevice": root.stat().st_dev, "backupRoot": str(root), "method": "clone" if clone else "guarded-copy", "liveReadSeconds": live_seconds, "copySeconds": copy_seconds, "checkSeconds": check_seconds, "hashSeconds": hash_seconds, "copyBps": copy_bps, "checkBps": size / check_seconds, "hashBps": size / hash_seconds}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=state, delete=False) as output:
            temporary = Path(output.name)
            json.dump(record, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, state / RECORD)
        fsync(state)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print(json.dumps({"step": "backup-calibrated", "record": str(state / RECORD), "scratchRemoved": not Path(raw).exists(), **record}))
