import argparse
import json
import mmap
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import live_read_guard as guard
from .install_disk_room import write_rate
from .io_priority import background_command

METHOD = "pinned-file-sync"
PAGE = 4096
CHUNK = 1 << 20
READ_MIB_S = 160
PIN_MAX_S = 3600
POLL_S = 1.0
WAL_COPY_MIB_S = 400


class Pin:
    def __init__(self, db, limit, max_s=PIN_MAX_S):
        self.db, self.limit = Path(db), limit
        self.process = subprocess.Popen([sys.executable, "-B", "-m", "t3nightly.install_live_sync", "pin", "--db", str(self.db), "--parent", str(os.getpid())],
                                        cwd=Path(__file__).resolve().parent.parent, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if self.process.stdout.readline().strip() != "pinned":
            self.process.stdin.close()
            error = self.process.stderr.read().strip()
            self.process.wait()
            raise ValueError(f"read pin did not start: {error[-300:]}")
        self.lock = threading.Lock()
        self.started = time.monotonic()
        self.deadline = self.started + max_s
        self.startWal = guard.wal_in_use(self.db)
        self.peak, self.lost = self.startWal, None
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.watch, daemon=True)
        self.thread.start()

    def watch(self):
        while not self.done.wait(POLL_S):
            try:
                wal = guard.wal_in_use(self.db)
            except OSError as error:
                self.release(f"live WAL unreadable: {type(error).__name__}")
                return
            self.peak = max(self.peak, wal)
            if self.process.poll() is not None:
                self.release(f"read pin process exited {self.process.returncode}")
            elif wal >= self.limit:
                self.release(f"live WAL reached {wal / 2**20:.1f} MiB under the read pin, over the {self.limit / 2**20:.1f} MiB limit")
            elif time.monotonic() >= self.deadline:
                self.release("read pin passed its time limit")

    @property
    def held(self):
        return self.process.poll() is None and self.lost is None

    def release(self, reason=None):
        with self.lock:
            if reason and self.lost is None:
                self.lost = reason
            self.done.set()
            if self.process.stdin.closed:
                return
            self.process.stdin.close()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process.stdout.close()
            self.process.stderr.close()

    def summary(self):
        return {"heldSeconds": round(time.monotonic() - self.started, 3), "walStartBytes": self.startWal, "walPeakBytes": self.peak, "walLimitBytes": self.limit, "lost": self.lost}


def open_source(path):
    try:
        return os.open(path, os.O_RDONLY | os.O_DIRECT), True
    except (AttributeError, OSError):
        return os.open(path, os.O_RDONLY), False


def sync_file(source, target, read_bps, write_bps, deadline=None):
    started = time.monotonic()
    src, direct = open_source(source)
    dst = os.open(target, os.O_RDWR | os.O_CREAT, 0o600)
    buffer = mmap.mmap(-1, CHUNK)
    whole = memoryview(buffer)
    view = whole[:0]
    offset = read = written = changed = 0
    budget_read = budget_write = started
    try:
        size = os.fstat(src).st_size
        if os.fstat(dst).st_size > size:
            os.ftruncate(dst, size)
        while True:
            size = os.fstat(src).st_size
            if offset >= size:
                break
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("live file sync passed its deadline")
            length = min(CHUNK, size - offset)
            view = whole[:length]
            try:
                got = os.preadv(src, [view], offset)
            except OSError:
                if not direct:
                    raise
                os.close(src)
                src, direct = os.open(source, os.O_RDONLY), False
                got = os.preadv(src, [view], offset)
            if got <= 0:
                break
            theirs = os.pread(dst, got, offset)
            if view[:got] != theirs:
                changed += 1
                for page in range(0, got, PAGE):
                    end = min(got, page + PAGE)
                    with view[page:end] as piece:
                        if piece != theirs[page:end]:
                            os.pwrite(dst, piece, offset + page)
                            written += end - page
                            budget_write += (end - page) / write_bps
            view.release()
            os.posix_fadvise(dst, offset, got, os.POSIX_FADV_DONTNEED)
            read += got * 2
            offset += got
            budget_read += got * 2 / read_bps
            pause = max(budget_read, budget_write) - time.monotonic()
            if pause > 0:
                time.sleep(pause)
        os.ftruncate(dst, offset)
        os.fsync(dst)
    finally:
        os.close(src)
        os.close(dst)
        view.release()
        whole.release()
        buffer.close()
    return {"bytes": offset, "readBytes": read, "writtenBytes": written, "pagesWritten": written // PAGE, "changedChunks": changed, "directReads": direct, "seconds": round(time.monotonic() - started, 3)}


def run_sync(source, target, read_bps, write_bps, timeout, note):
    command = background_command([sys.executable, "-B", "-m", "t3nightly.install_live_sync", "sync", "--source", str(source), "--target", str(target), "--read-bps", str(int(read_bps)), "--write-bps", str(int(write_bps)), "--parent", str(os.getpid())])
    result = subprocess.run(command, cwd=Path(__file__).resolve().parent.parent, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise ValueError(f"live file sync exited {result.returncode}: {result.stderr.strip()[-300:]}")
    stats = json.loads(result.stdout.strip().splitlines()[-1])
    note("live-file-sync", **stats)
    return stats


def hold(db, parent):
    guard.bind_to_parent(parent)
    connection = sqlite3.connect(f"{Path(db).resolve().as_uri()}?mode=ro", uri=True, timeout=5, isolation_level=None)
    mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
    if mode != "wal":
        raise SystemExit(f"live database journal mode is {mode}, not wal")
    connection.execute("BEGIN")
    connection.execute("SELECT count(*) FROM sqlite_schema").fetchone()
    print("pinned", flush=True)
    sys.stdin.read()
    connection.close()
    return 0


def start(source, target, note, *, timeout, read_bps=READ_MIB_S << 20):
    try:
        pin = Pin(source, guard.headroom_limit(source))
    except (OSError, ValueError) as error:
        note("live-file-sync-unpinned", error=str(error)[:300])
        return None, {"method": METHOD, "outcome": "unpinned", "lost": str(error)[:300]}
    try:
        stats = run_sync(source, target, read_bps, write_rate(target.parent), timeout, note)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        pin.release(f"live file sync failed: {type(error).__name__}: {str(error)[:200]}")
        note("live-file-sync-failed", **pin.summary())
        return None, {"method": METHOD, "outcome": "failed", **pin.summary()}
    if not pin.held:
        note("live-file-sync-unpinned", **pin.summary())
        return None, {"method": METHOD, "outcome": "unpinned", "sync": stats, **pin.summary()}
    return pin, {"method": METHOD, "outcome": "pinned", "sync": stats, **pin.summary()}


def wal_state(db):
    wal = Path(f"{db}-wal")
    if not wal.exists():
        return None
    stat = wal.stat()
    return stat.st_size, stat.st_mtime_ns, guard.wal_in_use(db)


def copy_wal(pin, source, target, *, stopped=True):
    if pin is None or not pin.held:
        raise ValueError(f"read pin was not held to the stop: {pin.lost if pin else 'never pinned'}")
    started = time.monotonic()
    for suffix in ("-wal", "-shm", "-journal"):
        Path(f"{target}{suffix}").unlink(missing_ok=True)
    before = wal_state(source)
    if before is not None:
        shutil.copyfile(f"{source}-wal", f"{target}-wal")
        os.chmod(f"{target}-wal", 0o600)
    after = wal_state(source)
    held = pin.held
    summary = pin.summary()
    pin.release()
    if (stopped and before != after) or not held:
        for suffix in ("-wal", "-shm"):
            Path(f"{target}{suffix}").unlink(missing_ok=True)
        raise ValueError("live WAL changed or the pin dropped while the stopped WAL was copied")
    return {"walBytes": before[0] if before else 0, "walInUseBytes": before[2] if before else 0, "seconds": round(time.monotonic() - started, 3), "pin": summary}


def stop_estimate(source):
    wal = Path(f"{source}-wal")
    size = max(wal.stat().st_size if wal.exists() else 0, guard.headroom_limit(source) // 8)
    return round(size / (WAL_COPY_MIB_S << 20), 3)


def main():
    parser = argparse.ArgumentParser(prog="python -m t3nightly.install_live_sync")
    commands = parser.add_subparsers(dest="command", required=True)
    sync = commands.add_parser("sync", help="bring a copy up to a live database file page by page; the caller holds the read pin")
    sync.add_argument("--source", type=Path, required=True)
    sync.add_argument("--target", type=Path, required=True)
    sync.add_argument("--read-bps", type=int, default=READ_MIB_S << 20)
    sync.add_argument("--write-bps", type=int, required=True)
    sync.add_argument("--parent", type=int, required=True)
    pin = commands.add_parser("pin", help="hold a read transaction open on a live database until stdin closes")
    pin.add_argument("--db", type=Path, required=True)
    pin.add_argument("--parent", type=int, required=True)
    args = parser.parse_args()
    if args.command == "pin":
        return hold(args.db, args.parent)
    guard.bind_to_parent(args.parent)
    print(json.dumps(sync_file(args.source, args.target, args.read_bps, args.write_bps)), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
