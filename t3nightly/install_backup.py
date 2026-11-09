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

from .install_database_copy import copy_rate, database_copy, require_space
from .install_calibration import rates
from .install_restore_copy import checksum, estimate, fsync, identity, verify
from .install_backup_retention import KEEP, best_effort, kept_on_live_volume, mark
from .install_clone_floor import room


def quiescent(run, db):
    paths = [str(path) for path in (db, Path(str(db) + "-wal"), Path(str(db) + "-shm")) if path.exists()]
    result = subprocess.run(["/usr/sbin/lsof", "-F", "pc", *paths], capture_output=True, text=True, timeout=15, check=False)
    holders = []
    for line in result.stdout.splitlines():
        if line.startswith("p"):
            holders.append({"pid": int(line[1:]), "command": ""})
        elif line.startswith("c") and holders:
            holders[-1]["command"] = line[1:]
    if result.returncode not in (0, 1) or holders or result.stderr.strip():
        record = {"outcome": "busy", "holders": holders, "lsofExit": result.returncode, "lsofError": result.stderr.strip()[:500], "retryable": True}
        run.report["databaseQuiescence"] = record
        run.step("hard-quiescence-refused", **record)
        named = ", ".join(f"{holder['pid']} {holder['command']}" for holder in holders) or "none named"
        raise ValueError(f"database users remain or lsof could not establish quiescence; holders: {named}")


def advisory(run, backup):
    output = run.state / "backup-quick-check.json"
    log = run.state / "backup-quick-check.log"
    with log.open("ab") as handle:
        process = subprocess.Popen([sys.executable, "-B", "-m", "t3nightly.install_backup", str(Path(backup["path"]).resolve()), str(output.resolve())], cwd=Path(__file__).resolve().parent.parent, stdin=subprocess.DEVNULL, stdout=handle, stderr=handle, start_new_session=True)
    run.step("advisory-backup-check", pid=process.pid, output=str(output), log=str(log))


def _capture(run, previous, stop, rollback_gate, *, keep_local=False):
    started = time.monotonic()
    source = run.db.resolve()
    size = sum(path.stat().st_size for path in (source, Path(str(source) + "-wal")) if path.exists())
    root = run.backups
    clone_root = run.home / "runtime/rollback-backups"
    volume_reason = "APFS clone unavailable on this platform"
    clones = 1
    if sys.platform == "darwin" and (keep_local or getattr(run.args, "compact_db", False)):
        run.step("backup-prune", **best_effort(run.backups, None, run.home, keep=KEEP - 1))
    if sys.platform == "darwin" and keep_local:
        clone_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        clones += kept_on_live_volume(run.home, run.backups, KEEP - 1)
        if source.stat().st_dev == clone_root.stat().st_dev and room(clone_root, run.home, clones)["passes"]:
            root = clone_root
            volume_reason = "same-volume clone above the free-space floor plus one database size per live-volume clone"
        else:
            volume_reason = "same-volume free-space floor refused clone; configured-root full copy"

    require_space(run.backups, size)
    require_space(root, size, clone=root == clone_root)
    destination = root / uuid.uuid4().hex
    destination.mkdir(mode=0o700)
    run.backup_attempt_directories.append(destination)
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
            require_space(root, size)
            destination = root / uuid.uuid4().hex
            destination.mkdir(mode=0o700)
            run.backup_attempt_directories.append(destination)
            target = destination / "statev2.sqlite"
            volume_reason = "APFS capability probe failed; configured-root full copy"
    binary = rollback_gate()
    if keep_local and not binary:
        host_rates = rates(run.state, size, source, root=root, clone=clone)
        work = estimate(size, clone=clone, rates=host_rates, check_passes=2 if clone else 1)
        restore_clone = clone and root.stat().st_dev == source.parent.stat().st_dev
        rollback = estimate(size, clone=restore_clone, rates=host_rates, rollback=True, hash_passes=1 if restore_clone or shutil.disk_usage(source.parent).free >= size + (512 << 20) else 2)
        budget = run.args.offbox_stop_s
        run.step("hard-backup-estimate", stoppedWork=["apfs-clone" if clone else "sqlite-backup", "quick_check", "identity", "sha256"], localRestoreCopy=work, rollback=rollback, estimateSeconds=max(work["totalSeconds"], rollback["totalSeconds"]), budgetSeconds=budget)
        if max(work["totalSeconds"], rollback["totalSeconds"]) > budget:
            raise ValueError(f"local backup or rollback exceeds --offbox-stop-s {budget} estimate; nothing stopped")
    require_space(run.backups, size)
    require_space(root, size, clone=clone)
    stop()
    if sys.platform == "darwin":
        quiescent(run, source)
    if binary:
        metadata = {"method": "binary-rollback", **binary, "seconds": round(time.monotonic() - started, 3), "previous": previous, "complete": True}
        destination.rmdir()
        run.step("hard-backup", **metadata)
        return metadata
    if keep_local:
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
                if not room(root, run.home, clones)["passes"]:
                    raise ValueError("clone free-space floor no longer holds")
                method, reason = "apfs-clone", volume_reason
            except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
                for suffix in ("", "-wal", "-shm"):
                    Path(str(target) + suffix).unlink(missing_ok=True)
                reason = "APFS clone or verification failed; configured-root full copy fallback"
                if root != run.backups:
                    destination.rmdir()
                    root = run.backups
                    require_space(root, size)
                    destination = root / uuid.uuid4().hex
                    destination.mkdir(mode=0o700)
                    run.backup_attempt_directories.append(destination)
                    target = destination / "statev2.sqlite"
        if method == "sqlite-backup":
            full = estimate(size, rates=rates(run.state, size, source, root=root, clone=False))
            remaining = deadline - time.monotonic()
            run.step("hard-backup-full-copy-budget", estimate=full, remainingSeconds=remaining)
            if full["totalSeconds"] > remaining:
                raise ValueError("full-copy backup fallback exceeds remaining stop budget; old database preserved, restart old service")
            database_copy(source, target, min(deadline, time.monotonic() + 120 + size / copy_rate(source)))
        os.chmod(target, 0o600)
        fsync(target)
        fsync(destination)
        check = verify(target, expected, deadline)
        local = {"sha256": checksum(target, deadline), "path": str(target), "bytes": target.stat().st_size, "quickCheck": check, "identity": expected, "previous": previous, "method": method, "methodReason": reason, "volumeDevice": root.stat().st_dev, "backupRoot": str(root)}
    else:
        database_copy(source, target, time.monotonic() + 120 + size / copy_rate(source))
    metadata = {"path": str(target), "method": method if keep_local else ("apfs-clone" if clone else "sqlite-backup"), "seconds": round(time.monotonic() - started, 3), "previous": previous, "complete": True}
    if keep_local:
        metadata["local"] = local
    (destination / "payload.json").write_text(json.dumps(metadata))
    try:
        mark(target, metadata, run.home)
    except Exception as error:
        metadata["markError"] = f"{type(error).__name__}: {error}"
        run.step("backup-mark", path=str(target), error=metadata["markError"])
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


def quick_check_backup(backup, output):
    started = time.monotonic()
    try:
        with closing(sqlite3.connect(f"{Path(backup).as_uri()}?mode=ro", uri=True)) as connection:
            rows = connection.execute("PRAGMA quick_check").fetchall()
        result = {"outcome": "passed" if rows == [("ok",)] else "failed", "rows": rows}
    except (OSError, sqlite3.Error) as error:
        result = {"outcome": "failed", "error": str(error)}
    Path(output).write_text(json.dumps({**result, "seconds": round(time.monotonic() - started, 3)}))


if __name__ == "__main__":
    quick_check_backup(sys.argv[1], sys.argv[2])
