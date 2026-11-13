import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import closing
from pathlib import Path

from . import live_read_guard as guard
from .db_publish import fsync, wal_bytes
from .install_restore_copy import RecoveryRequired, check_deadline, foreground_io, identity, ionice, service_active
from .install_sqlite_sync import executable, local_command, local_sync, page_updates

METHOD = "predrain-sqlite3-rsync"
RSYNC_MIB_S = 200
PASSES = 2
ALLOWANCE_S = 30
HEADER_PAGES = 1
CHUNK = 1024 * 1024
STOPPED_WORK = ["sqlite3-rsync-delta", "sqlite3-rsync-verify", "identity"]


def available():
    try:
        executable()
    except ValueError:
        return False
    return True


def estimate(size, pass_seconds=None):
    seconds = size / (RSYNC_MIB_S << 20) if pass_seconds is None else pass_seconds
    return {"method": METHOD, "passSeconds": round(seconds, 3), "passes": PASSES, "allowanceSeconds": ALLOWANCE_S, "totalSeconds": round(PASSES * seconds + ALLOWANCE_S, 3),
            "source": f"constant {RSYNC_MIB_S} MiB/s" if pass_seconds is None else "measured online catch-up pass"}


def watched(source, target, limit, seconds):
    started = time.monotonic()
    backstop = started + seconds
    peak, abort = guard.wal_in_use(source), None
    process = subprocess.Popen(local_command(source, target, background=True), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        while process.poll() is None:
            peak = max(peak, guard.wal_in_use(source))
            if peak >= limit:
                abort = guard.WalAbort(f"live WAL reached {peak / 2**20:.1f} MiB during the pre-drain sync, over the {limit / 2**20:.1f} MiB limit; nothing stopped")
            elif time.monotonic() >= backstop:
                abort = ValueError(f"pre-drain sync passed its {seconds} s deadline; nothing stopped")
            if abort:
                break
            time.sleep(guard.POLL_S)
    finally:
        if process.poll() is None:
            process.kill()
        output = process.communicate()[0]
    if abort:
        raise abort
    return {"pageUpdates": page_updates(source, target, process.returncode, output), "seconds": round(time.monotonic() - started, 3), "walPeak": peak}


def online(source, target, seconds, note):
    limit = guard.headroom_limit(source)
    passes = {}
    for name in ("seed", "catchUp"):
        passes[name] = guard.retried(lambda: watched(source, target, limit, seconds), lambda wait, error: note("predrain-sync-retry", phase=name, waitSeconds=wait, reason=str(error)))
    return {**passes, "walLimit": limit}


def prepare(run, source, target, size, budget):
    started = time.monotonic()
    presync = online(source, target, run.args.offbox_copy_s, run.step)
    presync["seconds"] = round(time.monotonic() - started, 3)
    work = estimate(size, presync["catchUp"]["seconds"])
    run.step("hard-backup-estimate", stoppedWork=STOPPED_WORK, localRestoreCopy=work, rollback=work, presync=presync, estimateSeconds=work["totalSeconds"], budgetSeconds=budget)
    if work["totalSeconds"] > budget:
        raise ValueError(f"pre-drain delta sync or rollback estimated at {work['totalSeconds']:.0f} s exceeds --offbox-stop-s {budget}; nothing stopped")
    return {"presync": presync, "stopEstimate": work}


def converge(origin, replica, deadline, what):
    try:
        moved = local_sync(origin, replica, deadline)
        verified = local_sync(origin, replica, deadline)
    except subprocess.TimeoutExpired as error:
        raise ValueError(f"{what} sqlite3_rsync passed its stopped-work deadline") from error
    if verified["pageUpdates"] > HEADER_PAGES:
        raise ValueError(f"{what} verify pass moved {verified['pageUpdates']} pages; the copy did not converge")
    return moved, verified


def settle_wal(path):
    if wal_bytes(path):
        with closing(sqlite3.connect(path, timeout=30, isolation_level=None)) as connection:
            if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] != 0:
                raise ValueError("restore copy WAL checkpoint is busy")
    if wal_bytes(path):
        raise ValueError("restore copy kept a WAL after its checkpoint")
    for suffix in ("-wal", "-shm"):
        Path(f"{path}{suffix}").unlink(missing_ok=True)


def take(run, source, target, prepared):
    stopped = time.monotonic()
    deadline = run.stop_deadline
    expected = identity(source, deadline=deadline)
    with foreground_io(run.step):
        moved, verified = converge(source, target, deadline, "restore copy")
    settle_wal(target)
    os.chmod(target, 0o600)
    fsync(target)
    fsync(target.parent)
    observed = identity(target, copy=True, deadline=deadline)
    if observed != expected:
        raise ValueError(f"restore copy identity {observed} differs from the stopped database {expected}")
    check_deadline(deadline)
    record = {"path": str(target), "bytes": target.stat().st_size, "method": METHOD, "identity": expected, "quickCheck": "pending", "sha256": None,
              **prepared, "delta": moved, "verify": verified, "stoppedSeconds": round(time.monotonic() - stopped, 3)}
    run.step("predrain-restore-copy", **{key: record[key] for key in ("path", "bytes", "delta", "verify", "stoppedSeconds", "stopEstimate")})
    return record


class Check(threading.Thread):
    def __init__(self, path):
        super().__init__(daemon=True)
        self.path, self.cancel, self.result = Path(path), threading.Event(), None

    def run(self):
        started = time.monotonic()
        ionice("-c3")
        try:
            with closing(sqlite3.connect(f"{self.path.resolve().as_uri()}?immutable=1", uri=True, timeout=30)) as connection:
                connection.set_progress_handler(lambda: int(self.cancel.is_set()), 10000)
                check = connection.execute("PRAGMA quick_check").fetchone()[0]
            checked = time.monotonic()
            digest = hashlib.sha256()
            with self.path.open("rb") as source:
                while chunk := source.read(CHUNK):
                    if self.cancel.is_set():
                        raise InterruptedError
                    digest.update(chunk)
            self.result = {"outcome": "passed" if check == "ok" else "failed", "quickCheck": check, "sha256": digest.hexdigest(),
                           "quickCheckSeconds": round(checked - started, 3), "sha256Seconds": round(time.monotonic() - checked, 3)}
        except (InterruptedError, OSError, sqlite3.Error) as error:
            self.result = {"outcome": "cancelled"} if self.cancel.is_set() else {"outcome": "failed", "error": f"{type(error).__name__}: {error}"}


def after_restart(run, backup):
    local = backup.get("local") or {}
    if local.get("method") != METHOD or getattr(run, "predrain_check", None):
        return
    run.predrain_check = Check(local["path"])
    run.predrain_check.start()
    run.step("predrain-copy-check-started", path=local["path"], ioPriority="idle")


def pause(run):
    check = getattr(run, "predrain_check", None)
    if check is not None:
        check.cancel.set()
        check.join()
        run.predrain_check = None
        run.step("predrain-copy-check-paused", reason="rollback restore runs at foreground priority")


def finish(run, backup):
    local = backup.get("local") or {}
    if local.get("method") != METHOD:
        return
    started = time.monotonic()
    if not Path(local["path"]).is_file():
        local.update(quickCheck="missing", deferredCheck={"outcome": "copy-missing"})
        run.step("predrain-copy-checked", loud=True, **local["deferredCheck"])
        return
    after_restart(run, backup)
    run.predrain_check.join()
    result = run.predrain_check.result
    local.update(quickCheck=result.get("quickCheck", "failed"), sha256=result.get("sha256"), deferredCheck={**result, "joinWaitSeconds": round(time.monotonic() - started, 3)})
    run.step("predrain-copy-checked", loud=result["outcome"] != "passed", **local["deferredCheck"])


def restore(record, db, note, deadline=None):
    started = time.monotonic()
    copy = Path(record["path"])
    observed = identity(copy, copy=True, deadline=deadline)
    if observed != record["identity"]:
        raise ValueError(f"restore copy identity {observed} differs from the install record; database preserved for forward repair")
    with foreground_io(note):
        try:
            moved, verified = converge(copy, db, deadline, "rollback restore")
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise RecoveryRequired(f"{error}; database recovery required before restart", "predrain-restore-incomplete") from error
    restored = identity(db)
    if restored != record["identity"]:
        raise RecoveryRequired(f"restored database identity {restored} differs from the stopped database {record['identity']}", "predrain-restore-mismatch")
    metadata = {"source": "local-restore-copy", "method": METHOD, "copy": str(copy), "into": "in-place-delta", "identity": restored, "delta": moved, "verify": verified, "seconds": round(time.monotonic() - started, 3)}
    note("hard-restore-db", **metadata)
    return metadata


def main():
    parser = argparse.ArgumentParser(prog="python -m t3nightly.install_predrain", description="Estimate or restore the pre-drain sqlite3_rsync restore copy of a restore-rollback install.")
    commands = parser.add_subparsers(dest="command", required=True)
    stop = commands.add_parser("estimate", help="print the stopped-work estimate from the database size; reads no database pages and controls no service")
    stop.add_argument("--db", type=Path, required=True)
    stop.add_argument("--budget", type=int, default=600, help="--offbox-stop-s the install would use")
    back = commands.add_parser("restore", help="restore the copy over a stopped service's database by delta sync")
    back.add_argument("--receipt", type=Path, required=True)
    back.add_argument("--db", type=Path, required=True)
    back.add_argument("--service", required=True)
    args = parser.parse_args()
    db = args.db.expanduser().resolve()
    if args.command == "estimate":
        size = db.stat().st_size + wal_bytes(db)
        work = estimate(size)
        print(json.dumps({"db": str(db), "bytes": size, "sqlite3Rsync": available(), "presyncSeconds": round(PASSES * size / (RSYNC_MIB_S << 20), 3), "stoppedWork": STOPPED_WORK,
                          "stopEstimate": work, "rollbackEstimate": work, "budgetSeconds": args.budget, "fits": work["totalSeconds"] <= args.budget}))
        return 0
    record = json.loads(args.receipt.read_text())["backup"]["local"]
    if record.get("method") != METHOD:
        sys.exit("receipt restore copy is not a pre-drain copy; use t3nightly.install_restore_copy")
    if service_active(args.service):
        sys.exit(f"{args.service} is active; stop it before restoring")
    restore(record, db, lambda step, **fields: print(json.dumps({"step": step, **fields}), flush=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
