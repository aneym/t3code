import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from contextlib import closing, contextmanager
from pathlib import Path

from .db_publish import LOCAL_MARGIN, fsync, wal_bytes
from .install_offbox_stage import staging
from .install_restore_hold import COPY_LOCK, create, flocked, forget, remove
from .install_storage import record_payload

STEP_PAGES = 4096
CHECK_MIB_S = 40
COPY_MIB_S = 360
HASH_MIB_S = 360


class RecoveryRequired(ValueError):
    def __init__(self, message, reason="deadline-before-restore", *, backup_path=None):
        super().__init__(message)
        self.reason = reason
        self.backup_path = backup_path



def check_deadline(deadline):
    if deadline is not None and time.monotonic() >= deadline:
        raise RecoveryRequired("restore copy exceeded its stopped-work deadline; database recovery required before restart")


def checksum(path, deadline=None):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while True:
            check_deadline(deadline)
            chunk = source.read(1024 * 1024)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)


def identity(path, *, copy=False, deadline=None):
    check_deadline(deadline)
    uri = f"{Path(path).resolve().as_uri()}?{'immutable=1' if copy else 'mode=rw'}"
    with closing(sqlite3.connect(uri, uri=True, timeout=30)) as connection:
        if deadline is not None:
            connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10000)
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {
            "pageCount": connection.execute("PRAGMA page_count").fetchone()[0],
            "schemaObjects": connection.execute("SELECT count(*) FROM sqlite_master").fetchone()[0],
            "migrationRows": {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ("effect_sql_migrations", "aneym_fork_migrations") if table in tables},
            "eventsMaxRowid": connection.execute("SELECT max(rowid) FROM orchestration_events").fetchone()[0] if "orchestration_events" in tables else None,
        }


def room(run, directory, size, *, stopped):
    floor = run.args.offbox_stage_floor_gib << 30
    free = shutil.disk_usage(directory).free
    if free < size + floor:
        run.step("restore-copy-refused", stageFreeBytes=free, sourceBytes=size, stageFloorBytes=floor)
        raise ValueError(f"offbox stage has {free >> 30} GiB free, under the {size >> 30} GiB restore copy plus the {floor >> 30} GiB floor" + ("" if stopped else "; nothing stopped"))


def precheck(run, source):
    room(run, staging(run), source.stat().st_size + wal_bytes(source), stopped=False)


def estimate(size, *, copy_bps=None, rollback=False):
    copy = size / (copy_bps or (COPY_MIB_S << 20)) * (2 if rollback else 1)
    check = size / (CHECK_MIB_S << 20) * (3 if rollback else 1)
    hashing = size / (HASH_MIB_S << 20) * (3 if rollback else 1)
    return {"copySeconds": round(copy, 3), "checkSeconds": round(check, 3), "checksumSeconds": round(hashing, 3), "totalSeconds": round(copy + check + hashing + 30, 3), "copyMiBs": (copy_bps / (1 << 20)) if copy_bps else COPY_MIB_S, "checkMiBs": CHECK_MIB_S, "checksumMiBs": HASH_MIB_S}


def ionice(*words):
    if not shutil.which("ionice"):
        return None
    try:
        result = subprocess.run(["ionice", *words, "-p", str(threading.get_native_id())], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


@contextmanager
def foreground_io(note):
    before = ionice()
    raised = bool(before and before.startswith("idle")) and ionice("-c2", "-n4") is not None
    if before is not None:
        note("restore-copy-io-priority", before=before, during="best-effort: prio 4" if raised else before)
    try:
        yield
    finally:
        if raised:
            ionice("-c3")


def verify(path, expected, deadline=None):
    check_deadline(deadline)
    if not Path(path).is_file():
        raise ValueError(f"restore copy {path} is missing")
    with closing(sqlite3.connect(f"{Path(path).resolve().as_uri()}?immutable=1", uri=True, timeout=30)) as connection:
        if deadline is not None:
            connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        try:
            check = connection.execute("PRAGMA quick_check").fetchone()[0]
        except sqlite3.OperationalError as error:
            check_deadline(deadline)
            raise ValueError(f"restore copy quick_check stopped at its deadline: {error}") from error
    if check != "ok":
        raise ValueError(f"restore copy quick_check {check}")
    try:
        observed = identity(path, copy=True, deadline=deadline)
    except sqlite3.Error:
        check_deadline(deadline)
        raise
    check_deadline(deadline)
    if observed != expected:
        raise ValueError(f"restore copy identity {observed} differs from the stopped database {expected}")
    return check


def take(run, source, previous, window):
    directory = staging(run)
    room(run, directory, source.stat().st_size + wal_bytes(source), stopped=True)
    started = time.monotonic()
    deadline = min(started + run.args.offbox_copy_s, window)
    expected = identity(source, deadline=window)
    target = directory / f"restore-{run.args.version}-{uuid.uuid4().hex[:8]}.sqlite"
    part = Path(f"{target}.part")

    def progress(*_):
        if time.monotonic() > deadline:
            raise TimeoutError("restore copy passed its --offbox-copy-s or --offbox-stop-s deadline")
    with flocked(directory / COPY_LOCK) as free:
        if not free:
            raise ValueError("another restore copy is in progress in the offbox stage")
        create(run, target)
        try:
            with foreground_io(run.step):
                with closing(sqlite3.connect(source, timeout=30)) as reader, closing(sqlite3.connect(part)) as writer:
                    reader.backup(writer, pages=STEP_PAGES, progress=progress)
                os.chmod(part, 0o600)
                fsync(part)
                os.replace(part, target)
                fsync(directory)
                copied = time.monotonic()
                check = verify(target, expected, window)
                digest = checksum(target, window)
        except BaseException:
            remove(part)
            remove(target)
            forget(target)
            raise
    record = {"path": str(target), "bytes": target.stat().st_size, "quickCheck": check, "identity": expected, "previous": previous, "seconds": round(time.monotonic() - started, 3),
              "sha256": digest, "copySeconds": round(copied - started, 3), "checkSeconds": round(time.monotonic() - copied, 3)}
    record_payload(run.state, "restore-copy", target, bytes=record["bytes"])
    run.step("restore-copy", **record)
    return record


def discard(run, record):
    freed = remove(record["path"])
    forget(record["path"])
    record_payload(run.state, "discard-restore-copy", record["path"], bytes=freed)
    return freed


def copy_checked(copy, target, record, deadline):
    digest = hashlib.sha256()
    with copy.open("rb") as source, target.open("wb") as output:
        while True:
            check_deadline(deadline)
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
            digest.update(chunk)
    if digest.hexdigest() != record["sha256"]:
        raise ValueError("restore copy checksum differs from the copy taken at install")
    return verify(target, record["identity"], deadline)


def beside(copy, db, mode, record, deadline):
    free = shutil.disk_usage(db.parent).free
    if free < copy.stat().st_size + LOCAL_MARGIN:
        raise OSError(f"{free >> 20} MiB beside the database cannot hold the {copy.stat().st_size >> 20} MiB restore copy")
    staged = db.with_name(f".{db.name}.restore-{uuid.uuid4().hex}")
    try:
        check = copy_checked(copy, staged, record, deadline)
        os.chmod(staged, mode)
        fsync(staged)
        check_deadline(deadline)
        for suffix in ("-wal", "-shm", "-journal"):
            Path(f"{db}{suffix}").unlink(missing_ok=True)
        os.replace(staged, db)
        fsync(db.parent)
    finally:
        remove(staged)
    return check


def in_place(copy, db, mode, record, deadline):
    check_deadline(deadline)
    if checksum(copy, deadline) != record["sha256"]:
        raise ValueError("restore copy checksum differs from the copy taken at install; database preserved")
    check_deadline(deadline)
    seconds = estimate(copy.stat().st_size)["totalSeconds"]
    if deadline is not None and deadline - time.monotonic() < seconds:
        raise RecoveryRequired(f"in-place restore needs {seconds:.0f} s before its stopped-work deadline; database preserved")
    remove(db)
    fsync(db.parent)
    check = copy_checked(copy, db, record, None)
    os.chmod(db, mode)
    fsync(db)
    return check


def restore(record, db, note, deadline=None, *, verified=False):
    started = time.monotonic()
    copy = Path(record["path"])
    if not verified:
        verify(copy, record["identity"], deadline)
    if not record.get("sha256"):
        raise ValueError("restore copy has no recorded checksum; database preserved for forward repair")
    mode = db.stat().st_mode & 0o777 if db.exists() else 0o600
    with foreground_io(note):
        try:
            check, into = beside(copy, db, mode, record, deadline), "beside"
        except OSError as error:
            check_deadline(deadline)
            note("hard-restore-local-beside-failed", copy=str(copy), error=str(error), next="delete the failed database and WAL, then copy in place")
            check, into = in_place(copy, db, mode, record, deadline), "in-place"
    metadata = {"sha256": record["sha256"], "identity": record["identity"], "source": "local-restore-copy", "copy": str(copy), "into": into, "quickCheck": check, "seconds": round(time.monotonic() - started, 3)}
    note("hard-restore-db", **metadata)
    return metadata


def service_active(service):
    if sys.platform == "darwin":
        result = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{service}"], capture_output=True, text=True, timeout=30, check=False)
        if result.returncode and "Could not find service" not in result.stderr:
            raise ValueError("cannot establish that the launchd service is stopped")
        return result.returncode == 0
    result = subprocess.run(["systemctl", "--user", "show", "--property=ActiveState", "--value", service], capture_output=True, text=True, timeout=30, check=False)
    if result.returncode or result.stdout.strip() not in ("active", "inactive", "failed", "activating", "deactivating", "reloading"):
        raise ValueError("cannot establish that the systemd service is stopped")
    return result.stdout.strip() not in ("inactive", "failed")


def main():
    parser = argparse.ArgumentParser(prog="python -m t3nightly.install_restore_copy", description="Verify or restore the local rollback copy an install recorded in its install receipt.")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (("verify", "quick_check the copy and compare its identity with the install record"), ("restore", "restore the copy over a stopped service's database")):
        command = commands.add_parser(name, help=text)
        command.add_argument("--receipt", type=Path, required=True, help="install receipt whose backup.local names the copy")
        if name == "restore":
            command.add_argument("--db", type=Path, required=True, help="database to replace, e.g. ~/.t3/userdata/statev2.sqlite")
            command.add_argument("--service", required=True, help="launchd label or systemd user unit that must be stopped first")
    offbox = commands.add_parser("restore-offbox", help="restore an off-box copy only with the service inactive")
    offbox.add_argument("--source", required=True)
    offbox.add_argument("--db", type=Path, required=True)
    offbox.add_argument("--service", required=True)
    args = parser.parse_args()
    if args.command == "restore-offbox":
        from .install_sqlite_sync import sync

        if service_active(args.service):
            sys.exit(f"{args.service} is active; stop it before restoring")
        sync(args.source, args.db.expanduser().resolve(), float("inf"), hang_guard=86400)
        return 0
    record = json.loads(args.receipt.read_text())["backup"]["local"]

    def note(step, **fields):
        print(json.dumps({"step": step, **fields}), flush=True)
    if args.command == "verify":
        note("restore-copy-verified", path=record["path"], quickCheck=verify(record["path"], record["identity"]))
        return 0
    if service_active(args.service):
        sys.exit(f"{args.service} is active; stop it before restoring")
    restore(record, args.db.expanduser().resolve(), note)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
