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


def database_copy(source, target, deadline):
    def progress(status, remaining, total):
        if time.monotonic() >= deadline:
            raise TimeoutError("rollback backup exceeded its deadline")

    with closing(sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)) as reader:
        with closing(sqlite3.connect(target)) as writer:
            reader.backup(writer, pages=4096, progress=progress)


def copy_rate(path):
    if sys.platform == "darwin":
        return 80_000_000
    device = os.stat(path).st_dev
    rotational = Path(f"/sys/dev/block/{os.major(device)}:{os.minor(device)}/queue/rotational")
    try:
        spinning = rotational.read_text().strip() == "1"
    except OSError:
        spinning = True
    return 15_000_000 if spinning else 40_000_000


def quiescent(db):
    paths = [str(path) for path in (db, Path(str(db) + "-wal"), Path(str(db) + "-shm")) if path.exists()]
    result = subprocess.run(["/usr/sbin/lsof", "-t", *paths], capture_output=True, text=True, timeout=15, check=False)
    if result.returncode not in (0, 1) or result.stdout.strip() or result.stderr.strip():
        raise ValueError("database users remain or lsof could not establish quiescence")


def _capture(run, previous, stop, rollback_gate, *, keep_local=False):
    started = time.monotonic()
    source = run.db.resolve()
    size = sum(path.stat().st_size for path in (source, Path(str(source) + "-wal")) if path.exists())
    root = run.backups
    clone_root = run.home / "runtime/rollback-backups"
    volume_reason = "APFS clone unavailable on this platform"
    if sys.platform == "darwin" and keep_local:
        clone_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if source.stat().st_dev == clone_root.stat().st_dev and shutil.disk_usage(clone_root).free >= size * 3:
            root = clone_root
            volume_reason = "same-volume clone with two database sizes reserved after clone"
        else:
            volume_reason = "same-volume space guard refused clone; configured-root full copy"

    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = root / uuid.uuid4().hex
    destination.mkdir(mode=0o700)
    run.backup_attempt_directories.append(destination)
    if shutil.disk_usage(root).free < max(size * 2, 512 * 1024 * 1024):
        raise ValueError("insufficient rollback backup disk space")
    target = destination / "statev2.sqlite"
    clone = sys.platform == "darwin" and root == clone_root and source.stat().st_dev == root.stat().st_dev
    if clone:
        probe = destination / ".clone-source"
        copied = destination / ".clone-target"
        probe.write_bytes(b"clone capability")
        result = subprocess.run(["/bin/cp", "-c", str(probe), str(copied)], capture_output=True, timeout=10, check=False)
        probe.unlink()
        copied.unlink(missing_ok=True)
        clone = result.returncode == 0
        if not clone:
            destination.rmdir()
            root = run.backups
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            destination = root / uuid.uuid4().hex
            destination.mkdir(mode=0o700)
            run.backup_attempt_directories.append(destination)
            target = destination / "statev2.sqlite"
            volume_reason = "APFS capability probe failed; configured-root full copy"
    binary = rollback_gate()
    if keep_local and not binary:
        from .install_restore_copy import estimate

        work = estimate(size, copy_bps=copy_rate(source))
        rollback = estimate(size, copy_bps=copy_rate(source), rollback=True)
        budget = run.args.offbox_stop_s
        run.step("hard-backup-estimate", stoppedWork=["sqlite-backup", "quick_check", "identity", "sha256"], localRestoreCopy=work, rollback=rollback, estimateSeconds=max(work["totalSeconds"], rollback["totalSeconds"]), budgetSeconds=budget)
        if max(work["totalSeconds"], rollback["totalSeconds"]) > budget:
            raise ValueError(f"local backup or rollback exceeds --offbox-stop-s {budget} estimate; nothing stopped")
    stop()
    if sys.platform == "darwin":
        quiescent(source)
    if binary:
        metadata = {"method": "binary-rollback", **binary, "seconds": round(time.monotonic() - started, 3), "previous": previous, "complete": True}
        destination.rmdir()
        run.step("hard-backup", **metadata)
        return metadata
    if keep_local:
        from .install_restore_copy import checksum, fsync, identity, verify

        deadline = run.stop_deadline
        expected = identity(source, deadline=deadline)
        method = "sqlite-backup"
        reason = volume_reason
        if clone:
            try:
                with closing(sqlite3.connect(source)) as connection:
                    if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] != 0:
                        raise ValueError("stopped database checkpoint is busy")
                subprocess.run(["/bin/cp", "-c", str(source), str(target)], check=True, capture_output=True, timeout=30)
                wal = Path(str(source) + "-wal")
                if wal.exists():
                    subprocess.run(["/bin/cp", "-c", str(wal), str(target) + "-wal"], check=True, capture_output=True, timeout=30)
                verify(target, expected, deadline)
                if shutil.disk_usage(root).free < size * 2:
                    raise ValueError("clone reserve below two database sizes")
                method, reason = "apfs-clone", volume_reason
            except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
                for suffix in ("", "-wal", "-shm"):
                    Path(str(target) + suffix).unlink(missing_ok=True)
                reason = "APFS clone or verification failed; configured-root full copy fallback"
                if root != run.backups:
                    destination.rmdir()
                    root = run.backups
                    root.mkdir(parents=True, exist_ok=True, mode=0o700)
                    destination = root / uuid.uuid4().hex
                    destination.mkdir(mode=0o700)
                    run.backup_attempt_directories.append(destination)
                    target = destination / "statev2.sqlite"
        if method == "sqlite-backup":
            database_copy(source, target, min(deadline, time.monotonic() + 120 + size / copy_rate(source)))
        os.chmod(target, 0o600)
        fsync(target)
        fsync(destination)
        check = verify(target, expected, deadline)
        local = {"sha256": checksum(target, deadline), "path": str(target), "bytes": target.stat().st_size, "quickCheck": check, "identity": expected, "previous": previous, "method": method, "methodReason": reason, "volumeDevice": root.stat().st_dev, "backupRoot": str(root)}
        from .install_backup_retention import mark

        mark(target, local, run.home)
    elif clone:
        for suffix in ("", "-wal"):
            original = Path(str(source) + suffix)
            if original.exists():
                subprocess.run(["/bin/cp", "-c", str(original), str(target) + suffix], check=True, capture_output=True, timeout=30)
    else:
        database_copy(source, target, time.monotonic() + 120 + size / copy_rate(source))
    metadata = {"path": str(target), "method": method if keep_local else ("apfs-clone" if clone else "sqlite-backup"), "seconds": round(time.monotonic() - started, 3), "previous": previous, "complete": True}
    if keep_local:
        metadata["local"] = local
    (destination / "payload.json").write_text(json.dumps(metadata))
    run.step("hard-backup", **metadata)
    return metadata


def capture(run, previous, stop, rollback_gate, *, keep_local=False):
    run.backup_attempt_directories = []
    try:
        return _capture(run, previous, stop, rollback_gate, keep_local=keep_local)
    except BaseException:
        for directory in run.backup_attempt_directories:
            if directory.exists() and not (directory / "at-stop.json").exists():
                shutil.rmtree(directory)
        raise


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
