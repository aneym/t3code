import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

from .install_backup_retention import inventory
from .install_restore_copy import RecoveryRequired, checksum, identity, restore
from .install_storage import EXTERNAL, backup_roots
from .snapshot_space import database_bytes

GIB = 1024**3
LIVE_FLOOR = 40 * GIB
TEMP_MARGIN = 10 * GIB
TIMEOUT_S = 2400
TAIL_BYTES = 4000
TEMP_ROOT = EXTERNAL / "tmp/t3-compact"
LOG_NAME = "compact-db-doctor.log"
UNSAFE = ("compaction-restore-failed", "compaction-restored-check-failed")


def header(db):
    db = Path(db)
    with db.open("rb") as handle:
        raw = handle.read(100)
    size = struct.unpack(">H", raw[16:18])[0]
    count, freelist, root, incremental = (struct.unpack(">I", raw[offset:offset + 4])[0] for offset in (28, 36, 52, 64))
    wal = Path(f"{db}-wal")
    return {"pageSize": 65536 if size == 1 else size, "pageCount": count, "freelistCount": freelist,
            "autoVacuum": 0 if not root else 2 if incremental else 1, "fileBytes": db.stat().st_size,
            "walBytes": wal.stat().st_size if wal.exists() else 0}


def quick_check(db):
    started = time.monotonic()
    try:
        with closing(sqlite3.connect(f"{Path(db).as_uri()}?mode=ro", uri=True)) as connection:
            rows = connection.execute("PRAGMA quick_check").fetchall()
        result = {"outcome": "ok" if rows == [("ok",)] else "failed", "rows": rows[:20]}
    except sqlite3.Error as error:
        result = {"outcome": "error", "error": str(error)}
    return {**result, "seconds": round(time.monotonic() - started, 3)}


def volume_backups(run, db):
    device = db.parent.stat().st_dev
    rows = [row for root in backup_roots(run.home, run.backups) for row in inventory(root, run.home)]
    return [{"path": row["path"], "bytes": row["bytes"], "marked": row["marked"]} for row in rows if Path(row["path"]).stat().st_dev == device]


def space(run, db, size, temp_root):
    clones = volume_backups(run, db)
    live_free = shutil.disk_usage(db.parent).free
    live_required = LIVE_FLOOR + size + size * len(clones)
    temp_free = shutil.disk_usage(temp_root).free
    temp_required = size + TEMP_MARGIN
    return {"databaseBytes": size,
            "live": {"directory": str(db.parent), "freeBytes": live_free, "floorBytes": LIVE_FLOOR, "walGrowthBytes": size,
                     "cloneBackups": clones, "cloneBytes": size * len(clones), "requiredBytes": live_required, "passes": live_free >= live_required},
            "temp": {"directory": str(temp_root), "freeBytes": temp_free, "marginBytes": TEMP_MARGIN, "requiredBytes": temp_required,
                     "sameVolumeAsDatabase": temp_root.stat().st_dev == db.parent.stat().st_dev, "passes": temp_free >= temp_required}}


def doctor(run, scratch, timeout):
    binary = run.runtime(run.args.version)
    log = run.state / LOG_NAME
    env = {**os.environ, "HOME": str(scratch), "TMPDIR": str(scratch), "SQLITE_TMPDIR": str(scratch)}
    argv = [str(binary), "doctor", "--base-dir", str(run.home), "--fix"]
    started = time.monotonic()
    code = None
    with log.open("wb") as handle:
        try:
            code = subprocess.run(argv, cwd=scratch, env=env, stdin=subprocess.DEVNULL, stdout=handle, stderr=subprocess.STDOUT, timeout=timeout, check=False).returncode
        except subprocess.TimeoutExpired:
            pass
    seconds = round(time.monotonic() - started, 3)
    text = log.read_bytes().decode(errors="replace")
    if code is None:
        outcome = "timed-out"
    elif "DatabaseInUseError" in text:
        outcome = "refused-in-use"
    elif "DatabaseProjectionsInvalidError" in text:
        outcome = "refused-projections-invalid"
    elif code == 0 and ("No recommended repairs" in text or "Nothing to repair" in text):
        outcome = "nothing-to-repair"
    elif code == 0:
        outcome = "compacted"
    else:
        outcome = "failed"
    return {"argv": argv, "binary": str(binary), "outcome": outcome, "exitCode": code, "seconds": seconds, "timeoutSeconds": timeout,
            "log": str(log), "outputTail": text[-TAIL_BYTES:]}


def skip(record, reason):
    record.update(outcome="skipped", reason=reason)
    return record


def unsafe(record):
    return bool(record.get("error")) or record["doctor"]["outcome"] in ("timed-out", "failed") or record["quickCheck"]["outcome"] != "ok"


def source(backup):
    if backup.get("local"):
        return backup["local"]
    path = Path(backup["path"])
    record = {"path": str(path), "bytes": path.stat().st_size, "sha256": checksum(path), "source": "rollback-backup", "identity": None}
    try:
        record["identity"] = identity(path, copy=True)
    except sqlite3.Error as error:
        record["identityError"] = str(error)
    return record


def recover(run, backup, record, db):
    started = time.monotonic()
    copy = None
    try:
        copy = source(backup)
        record["restore"] = restore(copy, db, run.step)
        record["restoredQuickCheck"] = quick_check(db)
    except Exception as error:
        record["restore"] = {**record.get("restore", {}), "error": f"{type(error).__name__}: {error}"}
    record["restoreSeconds"] = round(time.monotonic() - started, 3)
    if (record.get("restoredQuickCheck") or {}).get("outcome") == "ok":
        record["outcome"] = "restored-from-backup"
        return
    reason = UNSAFE[1] if "restoredQuickCheck" in record else UNSAFE[0]
    record.update(outcome="recovery-required", reason=reason)
    if copy and not backup.get("local"):
        backup["local"] = copy
    path = None if copy else backup.get("path") or backup.get("remote") or str(db)
    raise RecoveryRequired(f"database failed integrity after compaction and {reason.removeprefix('compaction-').replace('-', ' ')}; service held stopped", reason, backup_path=path)


def run_step(run, backup, record, *, temp_root=TEMP_ROOT, timeout=TIMEOUT_S):
    db = run.db.resolve()
    record["database"] = str(db)
    if sys.platform != "darwin":
        return skip(record, "compaction is supported on macOS installs only")
    if not (backup.get("path") or backup.get("local") or backup.get("remote")):
        return skip(record, "no rollback database backup was taken before compaction")
    if not Path(temp_root).parent.is_dir():
        return skip(record, f"temp volume unavailable: {Path(temp_root).parent}")
    temp_root = Path(temp_root)
    temp_root.mkdir(mode=0o700, exist_ok=True)
    record["before"] = header(db)
    record["space"] = space(run, db, database_bytes(db), temp_root)
    if not record["space"]["live"]["passes"]:
        return skip(record, "database volume would fall under its free-space floor")
    if not record["space"]["temp"]["passes"]:
        return skip(record, "SQLite temp volume lacks the database size plus margin")
    scratch = Path(tempfile.mkdtemp(prefix="doctor-", dir=temp_root))
    record["tempDirectory"] = str(scratch)
    try:
        try:
            record["doctor"] = doctor(run, scratch, timeout)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
            record["tempCleaned"] = not scratch.exists()
        record["outcome"] = record["doctor"]["outcome"]
        record["after"] = header(db)
        record["quickCheck"] = quick_check(db)
    except Exception as error:
        record["error"] = f"{type(error).__name__}: {error}"
    if unsafe(record):
        recover(run, backup, record, db)
    return record


def compact(run, backup):
    if not getattr(run.args, "compact_db", False):
        return
    started = time.monotonic()
    record = {"requested": True, "sameVersion": run.report.get("previous") == run.args.version}
    held = None
    try:
        run_step(run, backup, record)
    except RecoveryRequired as error:
        held = error
    except Exception as error:
        record.update(outcome="error", error=f"{type(error).__name__}: {error}")
    record["stepSeconds"] = round(time.monotonic() - started, 3)
    if hasattr(run, "stop_deadline"):
        run.stop_deadline += record["stepSeconds"]
    run.report["databaseCompaction"] = record
    run.step("database-compaction", **{key: record.get(key) for key in ("outcome", "reason", "stepSeconds", "restoreSeconds")},
             quickCheck=(record.get("quickCheck") or {}).get("outcome"), restoredQuickCheck=(record.get("restoredQuickCheck") or {}).get("outcome"))
    if held:
        raise held


def served(run):
    record = run.report.get("databaseCompaction")
    if record is not None and getattr(run, "stopped_at", None) is not None:
        record["downtimeSeconds"] = round(time.monotonic() - run.stopped_at, 3)
