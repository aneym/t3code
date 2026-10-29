import json
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import closing
from pathlib import Path


def database_copy(source, target, deadline):
    def progress(status, remaining, total):
        if time.monotonic() >= deadline:
            raise TimeoutError("rollback backup exceeded its deadline")

    with closing(sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)) as reader:
        with closing(sqlite3.connect(target)) as writer:
            reader.backup(writer, pages=4096, progress=progress)


def quiescent(db):
    paths = [str(path) for path in (db, Path(str(db) + "-wal"), Path(str(db) + "-shm")) if path.exists()]
    result = subprocess.run(["/usr/sbin/lsof", "-t", *paths], capture_output=True, text=True, timeout=15, check=False)
    if result.returncode not in (0, 1) or result.stdout.strip() or result.stderr.strip():
        raise ValueError("database users remain or lsof could not establish quiescence")


def capture(run, previous, stop):
    started = time.monotonic()
    root = run.home / "runtime" / "rollback"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = root / uuid.uuid4().hex
    destination.mkdir(mode=0o700)
    source = run.db.resolve()
    size = sum(path.stat().st_size for path in (source, Path(str(source) + "-wal")) if path.exists())
    if shutil.disk_usage(root).free < max(size * 2, 512 * 1024 * 1024):
        raise ValueError("insufficient rollback backup disk space")
    target = destination / "statev2.sqlite"
    clone = sys.platform == "darwin" and source.stat().st_dev == root.stat().st_dev
    if clone:
        probe = destination / ".clone-source"
        copied = destination / ".clone-target"
        probe.write_bytes(b"clone capability")
        result = subprocess.run(["/bin/cp", "-c", str(probe), str(copied)], capture_output=True, timeout=10, check=False)
        probe.unlink()
        copied.unlink(missing_ok=True)
        clone = result.returncode == 0
    if not clone:
        database_copy(source, target, started + 120)
    stop()
    if sys.platform == "darwin":
        quiescent(source)
    if clone:
        for suffix in ("", "-wal"):
            original = Path(str(source) + suffix)
            if original.exists():
                subprocess.run(["/bin/cp", "-c", str(original), str(target) + suffix], check=True, capture_output=True, timeout=30)
    metadata = {"path": str(target), "method": "apfs-clone" if clone else "sqlite-backup", "seconds": round(time.monotonic() - started, 3), "previous": previous, "complete": True}
    (destination / "payload.json").write_text(json.dumps(metadata))
    run.step("hard-backup", **metadata)
    return metadata


def advisory(backup, output):
    started = time.monotonic()
    try:
        with closing(sqlite3.connect(f"{Path(backup).as_uri()}?mode=ro", uri=True)) as connection:
            rows = connection.execute("PRAGMA quick_check").fetchall()
        result = {"outcome": "passed" if rows == [("ok",)] else "failed", "rows": rows}
    except (OSError, sqlite3.Error) as error:
        result = {"outcome": "failed", "error": str(error)}
    Path(output).write_text(json.dumps({**result, "seconds": round(time.monotonic() - started, 3)}))


if __name__ == "__main__":
    advisory(sys.argv[1], sys.argv[2])
