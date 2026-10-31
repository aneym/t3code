import os
import sqlite3
from contextlib import closing
from pathlib import Path

LOCAL_MARGIN = 512 * 1024 * 1024


def local_check(path):
    with closing(sqlite3.connect(path, timeout=30, isolation_level=None)) as connection:
        check = connection.execute("PRAGMA quick_check").fetchone()[0]
        if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] != 0:
            raise ValueError("database WAL checkpoint is busy")
    return check


def wal_bytes(db):
    wal = Path(f"{db}-wal")
    return wal.stat().st_size if wal.exists() else 0


def fsync(path, flags=os.O_RDONLY):
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish(staged, db):
    wal = Path(f"{db}-wal")
    try:
        local_check(db)
    except (sqlite3.Error, ValueError):
        pass
    if wal_bytes(db):
        wal.unlink()
        Path(f"{db}-shm").unlink(missing_ok=True)
    for suffix in ("-wal", "-shm"):
        Path(f"{staged}{suffix}").unlink(missing_ok=True)
    fsync(staged)
    os.replace(staged, db)
    fsync(db.parent)
    wal.unlink(missing_ok=True)
    Path(f"{db}-shm").unlink(missing_ok=True)
    fsync(db.parent)
