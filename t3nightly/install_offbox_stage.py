import argparse
import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import time
import uuid
from contextlib import closing
from pathlib import Path

from .install_storage import record_payload
from .live_snapshot import checked_path

WAL_LIMIT = 16 * 1024 * 1024
WAL_WAIT_S = 120
POLL_S = 0.2


def wal_in_use(db):
    try:
        with open(f"{db}-shm", "rb") as handle:
            header = handle.read(48)
    except FileNotFoundError:
        return 0
    if len(header) < 24:
        return 0
    page, frames = struct.unpack_from("<HI", header, 14)
    return frames * ((65536 if page == 1 else page) + 24)


def staging(run):
    path = checked_path(run.args.offbox_stage, run.home)
    for parent in (*reversed(path.parents), path):
        if parent.is_symlink():
            raise ValueError(f"offbox stage directory is a symlink: {parent}")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)
    for stale in sorted({path / f"{entry.name.split('.sqlite')[0]}.sqlite" for entry in path.glob("stage-*.sqlite*") if not entry.is_symlink()}):
        discard(run, path, stale)
    return path


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def copy_command(source, target):
    command = [sys.executable, "-m", "t3nightly.install_offbox_stage", str(source), str(target)]
    ionice = shutil.which("ionice") if sys.platform != "darwin" else None
    return [ionice, "-c2", "-n7", *command] if ionice else command


def copy(run, directory, source, size):
    floor = run.args.offbox_stage_floor_gib << 30
    before = shutil.disk_usage(directory).free
    metrics = {"stageFloorBytes": floor, "stageFreeBefore": before, "sourceBytes": size}
    if before < size + floor:
        run.step("offbox-stage-refused", **metrics)
        raise ValueError(f"offbox stage has {before >> 30} GiB free, under the {size >> 30} GiB copy plus the {floor >> 30} GiB floor; nothing stopped")
    waited = time.monotonic() + min(WAL_WAIT_S, run.args.offbox_copy_s)
    while wal_in_use(source) >= WAL_LIMIT:
        if time.monotonic() >= waited:
            raise ValueError(f"live WAL stayed at {wal_in_use(source) >> 20} MiB, over the {WAL_LIMIT >> 20} MiB stage limit; nothing stopped")
        time.sleep(1)
    target = directory / f"stage-{uuid.uuid4().hex}.sqlite"
    metrics["walBefore"] = wal_in_use(source)
    deadline = time.monotonic() + run.args.offbox_copy_s
    started = time.monotonic()
    root = str(Path(__file__).resolve().parent.parent)
    env = dict(os.environ, PYTHONPATH=root + os.pathsep + os.environ.get("PYTHONPATH", ""))
    process = subprocess.Popen(copy_command(source, target), cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    peak, abort = metrics["walBefore"], None
    try:
        while process.poll() is None:
            peak = max(peak, wal_in_use(source))
            if peak >= WAL_LIMIT:
                abort = f"live WAL reached {peak / 2**20:.1f} MiB during the stage copy, over the {WAL_LIMIT / 2**20:.1f} MiB limit"
            elif time.monotonic() >= deadline:
                abort = f"stage copy passed its {run.args.offbox_copy_s} s deadline"
            if abort:
                process.kill()
                process.wait()
                break
            time.sleep(POLL_S)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    metrics.update(copySeconds=round(time.monotonic() - started, 3), walAfter=wal_in_use(source), walPeak=peak)
    if abort or process.returncode:
        reason = abort or process.stderr.read().decode(errors="replace").strip()[-300:]
        discard(run, directory, target)
        run.step("offbox-stage-aborted", reason=reason, **metrics)
        raise ValueError(f"{reason}; stage copy aborted, nothing stopped")
    os.chmod(target, 0o600)
    metrics["stageBytes"] = target.stat().st_size
    return target, metrics


def discard(run, directory, target):
    freed = 0
    for suffix in ("", "-wal", "-shm", "-journal"):
        path = Path(f"{target}{suffix}")
        if path.exists():
            freed += path.stat().st_size
            path.unlink()
    fsync_directory(directory)
    record_payload(run.state, "discard-offbox-stage", target, bytes=freed)
    return freed


def backup(source, target):
    with closing(sqlite3.connect(f"{Path(source).as_uri()}?mode=ro", uri=True, timeout=30)) as reader:
        with closing(sqlite3.connect(target)) as writer:
            reader.backup(writer, pages=-1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    backup(args.source, args.target)
