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
from .db_publish import wal_bytes
from .io_priority import background_command
from .install_restore_hold import sweep
from .install_storage import record_payload
from .live_snapshot import checked_path

WAL_GROWTH_BYTES = 512 * 1024 * 1024


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


def copy(run, directory, source, size):
    floor = run.args.offbox_stage_floor_gib << 30
    before = shutil.disk_usage(directory).free
    metrics = {"stageFloorBytes": floor, "stageFreeBefore": before, "sourceBytes": size}
    if before < size + floor:
        run.step("offbox-stage-refused", **metrics)
        raise ValueError(f"offbox stage has {before >> 30} GiB free, under the {size >> 30} GiB copy plus the {floor >> 30} GiB floor; nothing stopped")
    target = directory / f"stage-{uuid.uuid4().hex}.sqlite"
    try:
        return copied(run, directory, source, target, metrics)
    except BaseException:
        discard(run, directory, target)
        raise


def copied(run, directory, source, target, metrics):
    metrics["walBefore"] = guard.wal_in_use(source)
    wal_file_before = wal_bytes(source)
    metrics["walGrowthLimit"] = min(WAL_GROWTH_BYTES, shutil.disk_usage(source.parent).free // 16)
    seconds = run.args.offbox_copy_s
    backstop = time.monotonic() + seconds
    started = time.monotonic()
    root = str(Path(__file__).resolve().parent.parent)
    env = dict(os.environ, PYTHONPATH=root + os.pathsep + os.environ.get("PYTHONPATH", ""))
    command = background_command([sys.executable, "-m", "t3nightly.install_offbox_stage", str(source), str(target), "--parent", str(os.getpid())])
    process = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    peak, growth, abort = metrics["walBefore"], 0, None
    try:
        while process.poll() is None:
            peak = max(peak, guard.wal_in_use(source))
            growth = max(growth, peak - metrics["walBefore"], wal_bytes(source) - wal_file_before)
            if growth >= metrics["walGrowthLimit"]:
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
    peak = max(peak, guard.wal_in_use(source))
    growth = max(growth, peak - metrics["walBefore"], wal_bytes(source) - wal_file_before)
    metrics.update(copySeconds=round(time.monotonic() - started, 3), walAfter=guard.wal_in_use(source), walPeak=peak, walGrowthPeak=growth)
    code = abort or process.returncode
    if code:
        told = "" if abort else process.stderr.read().decode(errors="replace").strip()[-300:]
        if told:
            reason = told
        elif code == guard.WAL_EXIT:
            reason = f"live WAL grew {growth / 2**20:.1f} MiB during the snapshot, over the {metrics['walGrowthLimit'] / 2**20:.1f} MiB growth limit"
        elif code == guard.DEADLINE_EXIT:
            reason = f"stage copy passed its {seconds} s deadline"
        else:
            reason = f"stage copier exited {code}"
        run.step("offbox-stage-aborted", reason=reason, exit=code, **metrics)
        raise ValueError(f"{reason}; stage snapshot aborted, nothing stopped")
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


def backup(source, target):
    with closing(sqlite3.connect(f"{Path(source).as_uri()}?mode=ro", uri=True, timeout=30, isolation_level=None)) as reader:
        with closing(sqlite3.connect(target)) as writer:
            reader.backup(writer, pages=-1)
    with target.open("rb") as handle:
        os.fsync(handle.fileno())
    fsync_directory(target.parent)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--parent", type=int, required=True)
    args = parser.parse_args()
    guard.bind_to_parent(args.parent)
    backup(args.source, args.target)
