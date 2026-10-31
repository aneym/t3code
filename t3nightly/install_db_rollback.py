import os
import shutil
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path, PurePosixPath

from . import install_restore_copy as restore_copy
from .db_publish import LOCAL_MARGIN, local_check, publish, wal_bytes
from .install_offbox import rate, restore_space, schema_state, sync, target
from .release_eligibility import binary_rollback


def restore(run, backup, *, beside=None):
    started = time.monotonic()
    host, _, raw = backup["remote"].partition(":")
    replica = PurePosixPath(raw)
    if replica.name != "statev2.sqlite":
        raise ValueError("off-box backup must name a statev2.sqlite replica")
    target(f"{host}:{replica.parent}")
    address = backup["remote"]
    db = run.db.resolve()
    size = int(backup["bytes"])
    budget = run.args.offbox_seed_s
    free = shutil.disk_usage(db.parent).free
    if beside is None:
        beside = free >= max(size * 2, LOCAL_MARGIN) and size / rate(run) <= budget
    if not beside and free < restore_space(size, wal_bytes(db)):
        raise ValueError("insufficient local space for an in-place off-box restore")
    deadline = time.monotonic() + budget
    if beside:
        staged = db.with_name(f".{db.name}.restore-{uuid.uuid4().hex}")
        try:
            sync(address, staged, deadline)
            check = local_check(staged)
            if check != "ok":
                raise ValueError(f"restored database quick_check {check}")
            os.chmod(staged, db.stat().st_mode & 0o777 if db.exists() else 0o600)
            publish(staged, db)
        finally:
            for suffix in ("", "-wal", "-shm", "-journal"):
                Path(f"{staged}{suffix}").unlink(missing_ok=True)
    else:
        sync(address, db, deadline)
        check = local_check(db)
        if check != "ok":
            raise ValueError(f"restored database quick_check {check}")
    metadata = {"remote": address, "into": "beside" if beside else "in-place", "quickCheck": check, "seconds": round(time.monotonic() - started, 3)}
    run.step("hard-restore-db", **metadata)
    return metadata


def unchanged(run, backup):
    try:
        return schema_state(run.db) == backup.get("schemaState") and local_check(run.db.resolve()) == "ok"
    except (OSError, sqlite3.Error, ValueError):
        return False


def rollback_database(run, backup, compatibility):
    skippable = binary_rollback(compatibility)
    if skippable and unchanged(run, backup):
        run.step("hard-restore-db-skipped", reason="binary-rollback-compatible candidate; schema and migrations match the backup")
        return
    local = backup.get("local")
    if local:
        try:
            restore_copy.verify(local["path"], local["identity"])
        except (OSError, ValueError, sqlite3.Error) as error:
            run.step("hard-restore-local-unusable", loud=True, copy=local["path"], error=str(error), fallback="offbox-replica", replica=backup.get("replica", "verified"))
        else:
            restore_copy.restore(local, run.db.resolve(), run.step)
            return
    try:
        restore(run, backup)
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        intact = skippable and unchanged(run, backup)
        run.step("hard-restore-db-failed", error=str(error), databaseUnchanged=intact)
        if not intact:
            raise
