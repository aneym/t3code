import argparse
import fcntl
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

from . import install_live_sync as live
from .db_publish import fsync, wal_bytes
from .install_disk_room import reflinks, require
from .install_restore_copy import RecoveryRequired, check_deadline, foreground_io, identity, service_active
from .install_sqlite_sync import executable, local_sync
from .install_storage import backup_roots

METHOD = "predrain-sqlite3-rsync"
RSYNC_MIB_S = 200
PASSES = 2
ALLOWANCE_S = 30
HEADER_PAGES = 1
CHUNK = 1024 * 1024
STOPPED_WORK = ["sqlite3-rsync-delta", "identity"]
PINNED_WORK = ["stopped-wal-copy", "wal-replay", "identity"]
BASE = "prestop-replica"
AFTER_START = ["identity", "quick_check", "sha256"]
STOP_PASSES = 1
ALERTS = Path.home() / ".agent-rails/lanes/t3-fast-release/STATE.md"
NICE = ["nice", "-n", "19"]


def available():
    try:
        executable()
    except ValueError:
        return False
    return True


def estimate(size, pass_seconds=None, passes=PASSES):
    seconds = size / (RSYNC_MIB_S << 20) if pass_seconds is None else pass_seconds
    return {"method": METHOD, "passSeconds": round(seconds, 3), "passes": passes, "allowanceSeconds": ALLOWANCE_S, "totalSeconds": round(passes * seconds + ALLOWANCE_S, 3),
            "source": f"constant {RSYNC_MIB_S} MiB/s" if pass_seconds is None else "previous install's stopped delta, scaled to size"}


def base_lock(root):
    return Path(root) / f"{BASE}.lock"


def previous_copy(run, target, skip=()):
    found = []
    for root in backup_roots(run.home, run.backups):
        for record in root.glob("*/at-stop.json"):
            if record.parent in skip:
                continue
            try:
                value = json.loads(record.read_text())
            except (OSError, ValueError):
                continue
            local = value.get("local") if isinstance(value, dict) else None
            path = Path(local.get("path", "")) if isinstance(local, dict) else None
            if value.get("method") == METHOD and value.get("complete") and path and path.parent == record.parent and path != target and path.is_file():
                found.append((path.stat().st_mtime, str(path), local))
    return (Path(found[-1][1]), found[-1][2]) if (found := sorted(found)) else (None, None)


def measured_pass(local, size):
    delta = local.get("delta") or {}
    if delta.get("method") == live.METHOD:
        return None
    seconds, measured = delta.get("seconds"), local.get("bytes")
    if not isinstance(seconds, (int, float)) or not isinstance(measured, int) or measured <= 0 or seconds <= 0:
        return None
    return seconds * max(1.0, size / measured)


def seed_source(run, target):
    skip = []
    for root in backup_roots(run.home, run.backups):
        lock = base_lock(root)
        if lock.exists():
            with lock.open("a") as handle:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    skip.append(root / BASE)
    return previous_copy(run, target, skip)


def seed(run, target, size):
    started = time.monotonic()
    source, local = seed_source(run, target)
    clone = reflinks(target.parent)
    if source is None:
        require(target.parent, size, "the pre-drain restore copy (no earlier copy to seed from)", run.step)
        return {"seed": "none", "reflink": clone, "reason": "no earlier pre-drain copy; the live sync copies every page"}
    run.predrain_pass_s = measured_pass(local, size)
    consume = not clone and source.parent.name == BASE and source.stat().st_dev == target.parent.stat().st_dev
    if consume:
        os.replace(source, target)
        (source.parent / "at-stop.json").unlink(missing_ok=True)
        run.predrain_consumed = (target, source)
        return {"seed": "base-moved", "from": str(source), "reflink": False, "bytes": target.stat().st_size, "seconds": round(time.monotonic() - started, 3)}
    if not clone:
        require(target.parent, size, "the pre-drain restore copy seed (no reflink on this filesystem)", run.step)
    command = [*NICE, "ionice", "-c3", "cp", "--reflink=auto", "--sparse=always", str(source), str(target)]
    try:
        subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=run.args.offbox_copy_s, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        target.unlink(missing_ok=True)
        return {"seed": "failed", "from": str(source), "reflink": clone, "error": f"{type(error).__name__}"[:200], "seconds": round(time.monotonic() - started, 3)}
    return {"seed": "previous-copy", "from": str(source), "reflink": clone, "bytes": target.stat().st_size, "seconds": round(time.monotonic() - started, 3)}


def give_back(run):
    consumed = getattr(run, "predrain_consumed", None)
    release(run)
    if consumed is None:
        return
    target, source = consumed
    run.predrain_consumed = None
    if target.is_file() and not source.exists():
        source.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.replace(target, source)
        mark_base(source, {"returnedBy": "failed-install-before-stop"})


def mark_base(path, fields):
    record = {"method": METHOD, "complete": True, "prestop": True, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "local": {"path": str(path), "bytes": path.stat().st_size, "method": METHOD, **fields}}
    staged = path.parent / "at-stop.json.tmp"
    staged.write_text(json.dumps(record) + "\n")
    staged.chmod(0o600)
    os.replace(staged, path.parent / "at-stop.json")
    return record


def release(run):
    pin = getattr(run, "live_pin", None)
    if pin is not None:
        pin.release("install ended before the stopped WAL copy")
        run.live_pin = None


def prepare(run, source, target, size, budget):
    seeded = seed(run, target, size)
    run.step("predrain-seed", liveReads=0, **seeded)
    measured = getattr(run, "predrain_pass_s", None) if seeded["seed"] in ("previous-copy", "base-moved") else None
    run.live_pin, online = live.start(source, target, run.step, timeout=run.args.offbox_copy_s * 4)
    run.step("predrain-online-sync", **online)
    if run.live_pin is not None:
        seconds = live.stop_estimate(source)
        work = {"method": live.METHOD, "walCopySeconds": seconds, "allowanceSeconds": ALLOWANCE_S, "totalSeconds": round(seconds + ALLOWANCE_S, 3), "source": f"live WAL at {live.WAL_COPY_MIB_S} MiB/s"}
    else:
        work = estimate(size, measured, STOP_PASSES)
    back = estimate(size, measured)
    most = max(work["totalSeconds"], back["totalSeconds"])
    run.step("hard-backup-estimate", stoppedWork=PINNED_WORK if run.live_pin is not None else STOPPED_WORK, afterStart=AFTER_START, localRestoreCopy=work, rollback=back, seed=seeded, estimateSeconds=most, budgetSeconds=budget)
    if most > budget:
        release(run)
        raise ValueError(f"stopped delta sync or rollback estimated at {most:.0f} s exceeds --offbox-stop-s {budget}; nothing stopped")
    return {"seed": seeded, "online": online, "stopEstimate": work, "rollbackEstimate": back}


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
    pin, run.live_pin = getattr(run, "live_pin", None), None
    moved = None
    if pin is not None:
        try:
            moved = {"method": live.METHOD, **live.copy_wal(pin, source, target)}
        except (OSError, ValueError) as error:
            run.step("predrain-wal-copy-fallback", loud=True, error=str(error)[:300])
    if moved is None:
        with foreground_io(run.step):
            try:
                moved = local_sync(source, target, deadline)
            except subprocess.TimeoutExpired as error:
                raise ValueError("restore copy sqlite3_rsync passed its stopped-work deadline") from error
    settle_wal(target)
    os.chmod(target, 0o600)
    fsync(target)
    fsync(target.parent)
    observed = identity(target, copy=True, deadline=deadline)
    if observed != expected:
        raise ValueError(f"restore copy identity {observed} differs from the stopped database {expected}")
    check_deadline(deadline)
    record = {"path": str(target), "bytes": target.stat().st_size, "method": METHOD, "identity": expected, "quickCheck": "pending", "sha256": None,
              **prepared, "delta": moved, "verify": {"deferred": "after-start", "checks": AFTER_START}, "stoppedSeconds": round(time.monotonic() - stopped, 3)}
    run.step("predrain-restore-copy", **{key: record[key] for key in ("path", "bytes", "delta", "verify", "stoppedSeconds", "stopEstimate")})
    return record


class Check(threading.Thread):
    def __init__(self, path, expected):
        super().__init__(daemon=True)
        self.path, self.expected, self.cancel, self.result = Path(path), expected, threading.Event(), None

    def run(self):
        started = time.monotonic()
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 19)
        try:
            observed = identity(self.path, copy=True)
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
            matched = observed == self.expected
            self.result = {"outcome": "passed" if check == "ok" and matched else "failed", "identity": "matched" if matched else observed, "quickCheck": check, "sha256": digest.hexdigest(),
                           "quickCheckSeconds": round(checked - started, 3), "sha256Seconds": round(time.monotonic() - checked, 3)}
        except (InterruptedError, OSError, ValueError, sqlite3.Error) as error:
            self.result = {"outcome": "cancelled"} if self.cancel.is_set() else {"outcome": "failed", "error": f"{type(error).__name__}: {error}"}


def after_restart(run, backup):
    local = backup.get("local") or {}
    if local.get("method") != METHOD or getattr(run, "predrain_check", None):
        return
    run.predrain_check = Check(local["path"], local.get("identity"))
    run.predrain_check.start()
    run.step("predrain-copy-check-started", path=local["path"], cpuNice=19, checks=AFTER_START)


def pause(run):
    check = getattr(run, "predrain_check", None)
    if check is not None:
        check.cancel.set()
        check.join()
        run.predrain_check = None
        run.step("predrain-copy-check-paused", reason="rollback restore runs at foreground priority")


def finish(run, backup, stopped=False, restored=None):
    local = backup.get("local") or {}
    if local.get("method") != METHOD:
        return
    if stopped:
        if getattr(run, "predrain_check", None) is not None:
            run.predrain_check.cancel.set()
            run.predrain_check = None
        local["deferredCheck"] = {"outcome": "skipped-service-stopped"}
        run.step("predrain-copy-checked", loud=True, **local["deferredCheck"])
        return
    started = time.monotonic()
    if not Path(local["path"]).is_file():
        local.update(quickCheck="missing", deferredCheck={"outcome": "copy-missing"})
        run.step("predrain-copy-checked", loud=True, **local["deferredCheck"])
        alert(run, local)
        return
    after_restart(run, backup)
    run.predrain_check.join()
    result = run.predrain_check.result
    local.update(quickCheck=result.get("quickCheck", "failed"), sha256=result.get("sha256"), deferredCheck={**result, "joinWaitSeconds": round(time.monotonic() - started, 3)})
    run.step("predrain-copy-checked", loud=result["outcome"] != "passed", **local["deferredCheck"])
    if result["outcome"] not in ("passed", "cancelled"):
        alert(run, local)
    if restored and restored.get("method") == METHOD and restored.get("copy") == local["path"]:
        restored.update(quickCheck=local["quickCheck"], sha256=local["sha256"], deferredCheck={**local["deferredCheck"], "checked": local["path"]})
        run.step("predrain-restore-checked", loud=result["outcome"] != "passed", quickCheck=restored["quickCheck"], sha256=restored["sha256"])


def alert(run, local):
    record = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "alert": "predrain-copy-verify-failed", "version": run.args.version, "copy": local["path"],
              "deferredCheck": local["deferredCheck"], "action": "none: the candidate keeps serving; no automatic rollback. The restore copy is not proven; take a fresh copy before relying on it."}
    local["alert"] = record
    path = run.state / "predrain-verify-alert.json"
    path.write_text(json.dumps(record, indent=1) + "\n")
    run.step("predrain-copy-verify-alert", loud=True, path=str(path), **record)
    print(f"ALERT: restore copy verify failed after the start: {json.dumps(local['deferredCheck'])}; candidate kept serving, nothing rolled back", file=sys.stderr, flush=True)
    try:
        ALERTS.parent.mkdir(parents=True, exist_ok=True)
        with ALERTS.open("a") as handle:
            handle.write("\n- ALERT predrain copy verify failed: " + json.dumps(record, separators=(",", ":")) + "\n")
    except OSError as error:
        run.step("predrain-copy-verify-alert-unrecorded", loud=True, error=str(error))


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
        work, back = estimate(size, passes=STOP_PASSES), estimate(size)
        print(json.dumps({"db": str(db), "bytes": size, "sqlite3Rsync": available(), "liveReadsBeforeStop": 0, "stoppedWork": STOPPED_WORK, "afterStart": AFTER_START,
                          "stopEstimate": work, "rollbackEstimate": back, "budgetSeconds": args.budget, "fits": max(work["totalSeconds"], back["totalSeconds"]) <= args.budget}))
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
