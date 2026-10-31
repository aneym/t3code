import argparse
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

from .db_publish import LOCAL_MARGIN, fsync, local_check, publish, wal_bytes
from .install_offbox_stage import staging
from .install_restore_hold import COPY_LOCK, create, flocked, forget, remove
from .install_storage import record_payload

STEP_PAGES = 4096
CHECK_MIB_S = 40
COPY_MIB_S = 360


def identity(path, *, copy=False):
    uri = f"{Path(path).resolve().as_uri()}?{'immutable=1' if copy else 'mode=rw'}"
    with closing(sqlite3.connect(uri, uri=True, timeout=30)) as connection:
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


def estimate(size):
    copy, check = size / (COPY_MIB_S << 20), size / (CHECK_MIB_S << 20)
    return {"copySeconds": round(copy, 3), "checkSeconds": round(check, 3), "totalSeconds": round(copy + check + 30, 3), "copyMiBs": COPY_MIB_S, "checkMiBs": CHECK_MIB_S}


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
    if not Path(path).is_file():
        raise ValueError(f"restore copy {path} is missing")
    with closing(sqlite3.connect(f"{Path(path).resolve().as_uri()}?immutable=1", uri=True, timeout=30)) as connection:
        if deadline is not None:
            connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        try:
            check = connection.execute("PRAGMA quick_check").fetchone()[0]
        except sqlite3.OperationalError as error:
            raise ValueError(f"restore copy quick_check stopped at its deadline: {error}") from error
    if check != "ok":
        raise ValueError(f"restore copy quick_check {check}")
    observed = identity(path, copy=True)
    if observed != expected:
        raise ValueError(f"restore copy identity {observed} differs from the stopped database {expected}")
    return check


def take(run, source, previous, window):
    directory = staging(run)
    room(run, directory, source.stat().st_size + wal_bytes(source), stopped=True)
    started = time.monotonic()
    deadline = min(started + run.args.offbox_copy_s, window)
    expected = identity(source)
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
        except BaseException:
            remove(part)
            remove(target)
            forget(target)
            raise
    record = {"path": str(target), "bytes": target.stat().st_size, "quickCheck": check, "identity": expected, "previous": previous, "seconds": round(time.monotonic() - started, 3),
              "copySeconds": round(copied - started, 3), "checkSeconds": round(time.monotonic() - copied, 3)}
    record_payload(run.state, "restore-copy", target, bytes=record["bytes"])
    run.step("restore-copy", **record)
    return record


def discard(run, record):
    freed = remove(record["path"])
    forget(record["path"])
    record_payload(run.state, "discard-restore-copy", record["path"], bytes=freed)
    return freed


def beside(copy, db, mode):
    free = shutil.disk_usage(db.parent).free
    if free < copy.stat().st_size + LOCAL_MARGIN:
        raise ValueError(f"{free >> 20} MiB beside the database cannot hold the {copy.stat().st_size >> 20} MiB restore copy")
    staged = db.with_name(f".{db.name}.restore-{uuid.uuid4().hex}")
    try:
        shutil.copyfile(copy, staged)
        os.chmod(staged, mode)
        check = local_check(staged)
        if check != "ok":
            raise ValueError(f"restored database quick_check {check}")
        publish(staged, db)
    finally:
        remove(staged)
    return check


def in_place(copy, db, mode):
    remove(db)
    fsync(db.parent)
    shutil.copyfile(copy, db)
    os.chmod(db, mode)
    fsync(db)
    check = local_check(db)
    if check != "ok":
        raise ValueError(f"in-place restored database quick_check {check}")
    return check


def restore(record, db, note):
    started = time.monotonic()
    copy = Path(record["path"])
    observed = identity(copy, copy=True) if copy.is_file() else None
    if observed != record["identity"]:
        raise ValueError(f"restore copy {copy} is missing or differs from the copy taken at install")
    mode = db.stat().st_mode & 0o777 if db.exists() else 0o600
    with foreground_io(note):
        try:
            check, into = beside(copy, db, mode), "beside"
        except (OSError, ValueError, sqlite3.Error) as error:
            note("hard-restore-local-beside-failed", copy=str(copy), error=str(error), next="delete the failed database and WAL, then copy in place")
            check, into = in_place(copy, db, mode), "in-place"
    metadata = {"source": "local-restore-copy", "copy": str(copy), "into": into, "quickCheck": check, "seconds": round(time.monotonic() - started, 3)}
    note("hard-restore-db", **metadata)
    return metadata


def service_active(service):
    return subprocess.run(["systemctl", "--user", "is-active", "--quiet", service], capture_output=True, timeout=30, check=False).returncode == 0


def main():
    parser = argparse.ArgumentParser(prog="python -m t3nightly.install_restore_copy", description="Verify or restore the local rollback copy an off-box install recorded in its install receipt.")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (("verify", "quick_check the copy and compare its identity with the install record"), ("restore", "restore the copy over a stopped service's database")):
        command = commands.add_parser(name, help=text)
        command.add_argument("--receipt", type=Path, required=True, help="install receipt whose backup.local names the copy")
        if name == "restore":
            command.add_argument("--db", type=Path, required=True, help="database to replace, e.g. ~/.t3/userdata/statev2.sqlite")
            command.add_argument("--service", required=True, help="systemd user unit that must be stopped first")
    args = parser.parse_args()
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
