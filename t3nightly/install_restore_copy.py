import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import closing
from pathlib import Path

from .db_publish import LOCAL_MARGIN, fsync, local_check, publish, wal_bytes
from .install_offbox_stage import staging
from .install_storage import record_payload

STEP_PAGES = 4096
SUFFIXES = ("", "-wal", "-shm", "-journal")


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


def remove(path):
    freed = 0
    for suffix in SUFFIXES:
        part = Path(f"{path}{suffix}")
        if part.is_file() and not part.is_symlink():
            freed += part.stat().st_size
            part.unlink()
    return freed


def verify(path, expected):
    if not Path(path).is_file():
        raise ValueError(f"restore copy {path} is missing")
    with closing(sqlite3.connect(f"{Path(path).resolve().as_uri()}?immutable=1", uri=True, timeout=30)) as connection:
        check = connection.execute("PRAGMA quick_check").fetchone()[0]
    if check != "ok":
        raise ValueError(f"restore copy quick_check {check}")
    observed = identity(path, copy=True)
    if observed != expected:
        raise ValueError(f"restore copy identity {observed} differs from the stopped database {expected}")
    return check


def take(run, source, previous):
    directory = staging(run)
    room(run, directory, source.stat().st_size + wal_bytes(source), stopped=True)
    started = time.monotonic()
    deadline = started + run.args.offbox_copy_s
    expected = identity(source)
    target = directory / f"restore-{run.args.version}-{uuid.uuid4().hex[:8]}.sqlite"
    part = Path(f"{target}.part")

    def progress(*_):
        if time.monotonic() > deadline:
            raise TimeoutError(f"restore copy passed its --offbox-copy-s {run.args.offbox_copy_s} s deadline")
    try:
        with closing(sqlite3.connect(source, timeout=30)) as reader, closing(sqlite3.connect(part)) as writer:
            reader.backup(writer, pages=STEP_PAGES, progress=progress)
        os.chmod(part, 0o600)
        fsync(part)
        os.replace(part, target)
        fsync(directory)
        check = verify(target, expected)
    except BaseException:
        remove(part)
        remove(target)
        raise
    record = {"path": str(target), "bytes": target.stat().st_size, "quickCheck": check, "identity": expected, "previous": previous, "seconds": round(time.monotonic() - started, 3)}
    record_payload(run.state, "restore-copy", target, bytes=record["bytes"])
    run.step("restore-copy", **record)
    return record


def discard(run, record):
    freed = remove(record["path"])
    record_payload(run.state, "discard-restore-copy", record["path"], bytes=freed)
    return freed


def restore(record, db, note):
    started = time.monotonic()
    copy = Path(record["path"])
    observed = identity(copy, copy=True) if copy.is_file() else None
    if observed != record["identity"]:
        raise ValueError(f"restore copy {copy} is missing or differs from the copy taken at install")
    free = shutil.disk_usage(db.parent).free
    if free < copy.stat().st_size + LOCAL_MARGIN:
        raise ValueError(f"{free >> 20} MiB beside the database cannot hold the {copy.stat().st_size >> 20} MiB restore copy")
    staged = db.with_name(f".{db.name}.restore-{uuid.uuid4().hex}")
    try:
        shutil.copyfile(copy, staged)
        os.chmod(staged, db.stat().st_mode & 0o777 if db.exists() else 0o600)
        check = local_check(staged)
        if check != "ok":
            raise ValueError(f"restored database quick_check {check}")
        publish(staged, db)
    finally:
        remove(staged)
    metadata = {"source": "local-restore-copy", "copy": str(copy), "quickCheck": check, "seconds": round(time.monotonic() - started, 3)}
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
