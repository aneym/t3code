import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import closing
from pathlib import Path

from . import live_read_guard as guard
from .install_restore_hold import sweep
from .install_storage import record_payload
from .live_snapshot import checked_path

WAL_WAIT_S = 120
STEP_PAGES = 4096


def staging(run):
    path = checked_path(run.args.offbox_stage, run.home)
    for parent in (*reversed(path.parents), path):
        if parent.is_symlink():
            raise ValueError(f"offbox stage directory is a symlink: {parent}")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)
    swept = freed = 0
    for entry in path.glob("stage-*.sqlite*"):
        try:
            if entry.is_symlink() or not entry.is_file():
                continue
            size = entry.stat().st_size
            entry.unlink()
        except OSError:
            continue
        swept, freed = swept + 1, freed + size
    if swept:
        fsync_directory(path)
        record_payload(run.state, "discard-stale-offbox-stage", path, bytes=freed, files=swept)
    held = sweep(path)
    for action in held:
        if action["action"] == "leak-removed":
            record_payload(run.state, "discard-leaked-restore-copy", action["copy"], bytes=action["freedBytes"])
    if held:
        run.step("restore-hold-sweep", actions=held)
    return path


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def copy_command(source, target, seconds):
    command = [sys.executable, "-m", "t3nightly.install_offbox_stage", str(source), str(target), *guard.guard_words(seconds)]
    ionice = shutil.which("ionice") if sys.platform != "darwin" else None
    return [ionice, "-c2", "-n7", *command] if ionice else command


def copy(run, directory, source, size):
    return guard.retried(lambda: attempt(run, directory, source, size), lambda wait, error: run.step("offbox-stage-retry", waitSeconds=wait, reason=str(error)))


def attempt(run, directory, source, size):
    floor = run.args.offbox_stage_floor_gib << 30
    before = shutil.disk_usage(directory).free
    metrics = {"stageFloorBytes": floor, "stageFreeBefore": before, "sourceBytes": size}
    if before < size + floor:
        run.step("offbox-stage-refused", **metrics)
        raise ValueError(f"offbox stage has {before >> 30} GiB free, under the {size >> 30} GiB copy plus the {floor >> 30} GiB floor; nothing stopped")
    waited = time.monotonic() + min(WAL_WAIT_S, run.args.offbox_copy_s)
    while guard.wal_in_use(source) >= guard.WAL_LIMIT:
        if time.monotonic() >= waited:
            raise guard.WalAbort(f"live WAL stayed at {guard.wal_in_use(source) >> 20} MiB, over the {guard.WAL_LIMIT >> 20} MiB stage limit; nothing stopped")
        time.sleep(1)
    target = directory / f"stage-{uuid.uuid4().hex}.sqlite"
    try:
        return copied(run, directory, source, target, metrics)
    except BaseException:
        discard(run, directory, target)
        raise


def copied(run, directory, source, target, metrics):
    metrics["walBefore"] = guard.wal_in_use(source)
    seconds = run.args.offbox_copy_s
    backstop = time.monotonic() + seconds + guard.GRACE_S + 5
    started = time.monotonic()
    root = str(Path(__file__).resolve().parent.parent)
    env = dict(os.environ, PYTHONPATH=root + os.pathsep + os.environ.get("PYTHONPATH", ""))
    process = subprocess.Popen(copy_command(source, target, seconds), cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    peak, abort = metrics["walBefore"], None
    try:
        while process.poll() is None:
            peak = max(peak, guard.wal_in_use(source))
            if peak >= guard.WAL_LIMIT:
                abort = guard.WAL_EXIT
            elif time.monotonic() >= backstop:
                abort = guard.DEADLINE_EXIT
            if abort:
                break
            time.sleep(guard.POLL_S)
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
    metrics.update(copySeconds=round(time.monotonic() - started, 3), walAfter=guard.wal_in_use(source), walPeak=peak)
    code = abort or process.returncode
    if code:
        told = "" if abort else process.stderr.read().decode(errors="replace").strip()[-300:]
        if told:
            reason = told
        elif code == guard.WAL_EXIT:
            reason = f"live WAL reached {peak / 2**20:.1f} MiB during the stage copy, over the {guard.WAL_LIMIT / 2**20:.1f} MiB limit"
        elif code == guard.DEADLINE_EXIT:
            reason = f"stage copy passed its {seconds} s deadline"
        else:
            reason = f"stage copier exited {code}"
        run.step("offbox-stage-aborted", reason=reason, exit=code, **metrics)
        error = guard.WalAbort if code == guard.WAL_EXIT else ValueError
        raise error(f"{reason}; stage copy aborted, nothing stopped")
    os.chmod(target, 0o600)
    metrics["stageBytes"] = target.stat().st_size
    return target, metrics


def discard(run, directory, target):
    freed = 0
    for suffix in ("", "-wal", "-shm", "-journal"):
        path = Path(f"{target}{suffix}")
        if path.is_file() and not path.is_symlink():
            freed += path.stat().st_size
            path.unlink()
    fsync_directory(directory)
    record_payload(run.state, "discard-offbox-stage", target, bytes=freed)
    return freed


def backup(source, target, watch):
    with closing(sqlite3.connect(f"{Path(source).as_uri()}?mode=ro", uri=True, timeout=30, isolation_level=None)) as reader:
        watch.connection = reader
        reader.execute("BEGIN")
        reader.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        try:
            with closing(sqlite3.connect(target)) as writer:
                reader.backup(writer, pages=STEP_PAGES, progress=watch.check)
        finally:
            watch.connection = None
            if reader.in_transaction:
                reader.execute("ROLLBACK")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    guard.add_guard_arguments(parser)
    args = parser.parse_args()
    with guard.guarded(args.source, args.wal_limit, args.seconds, args.parent) as watch:
        backup(args.source, args.target, watch)
