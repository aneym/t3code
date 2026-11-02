import ctypes
import os
import shutil
import signal
import struct
import sys
import threading
import time
from contextlib import contextmanager

WAL_LIMIT = 16 * 1024 * 1024
WAL_CEILING = 1024 * 1024 * 1024
WAL_HEADROOM_SHARE = 100
RETRY_WAITS = (60, 120, 240)
POLL_S = 0.2
GRACE_S = 2
WAL_EXIT = 75
DEADLINE_EXIT = 76
PR_SET_PDEATHSIG = 1


class WalAbort(ValueError):
    pass


def wal_frames(header):
    if len(header) < 24:
        return 0
    page, frames = struct.unpack_from("<HI", header, 14)
    return frames * ((65536 if page == 1 else page) + 24)


def wal_in_use(db):
    try:
        with open(f"{db}-shm", "rb") as handle:
            return wal_frames(handle.read(48))
    except FileNotFoundError:
        return 0


def headroom_limit(db):
    free = shutil.disk_usage(os.path.dirname(os.path.realpath(db))).free
    return max(WAL_LIMIT, min(WAL_CEILING, free // WAL_HEADROOM_SHARE))


def guard_words(seconds, limit=WAL_LIMIT):
    return ["--parent", str(os.getpid()), "--wal-limit", str(limit), "--seconds", str(seconds)]


def retried(attempt, note):
    for wait in (*RETRY_WAITS, None):
        try:
            return attempt()
        except WalAbort as error:
            if wait is None:
                raise
            note(wait, error)
            time.sleep(wait)


def bind_to_parent(parent):
    if sys.platform.startswith("linux"):
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(PR_SET_PDEATHSIG, int(signal.SIGKILL), 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG) failed")
    if os.getppid() != parent:
        os._exit(1)


class Watch:
    def __init__(self, source, limit, seconds, parent):
        self.source, self.parent = source, parent
        self.shm = None
        self.sample_lock = threading.Lock()
        self.limit, self.deadline = limit, time.monotonic() + seconds
        self.connection, self.code, self.peak = None, 0, 0
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.watch, daemon=True)

    def sample(self):
        if os.getppid() != self.parent:
            os._exit(1)
        with self.sample_lock:
            if self.shm is None:
                try:
                    self.shm = os.open(f"{self.source}-shm", os.O_RDONLY)
                except FileNotFoundError:
                    pass
            wal = wal_frames(os.pread(self.shm, 48, 0)) if self.shm is not None else 0
        self.peak = max(self.peak, wal)
        if self.code:
            return
        if wal >= self.limit:
            self.code, reason = WAL_EXIT, f"live WAL reached {wal / 2**20:.1f} MiB, over the {self.limit / 2**20:.1f} MiB limit"
        elif time.monotonic() >= self.deadline:
            self.code, reason = DEADLINE_EXIT, "live read passed its deadline"
        else:
            return
        print(reason, file=sys.stderr, flush=True)

    def expire(self):
        if not self.done.is_set():
            os._exit(self.code)

    def watch(self):
        while not self.done.wait(POLL_S):
            try:
                self.sample()
            except OSError:
                self.code = WAL_EXIT
            if not self.code:
                continue
            killer = threading.Timer(GRACE_S, self.expire)
            killer.daemon = True
            killer.start()
            try:
                self.connection.interrupt()
            except Exception:
                pass
            if not self.done.wait(GRACE_S):
                os._exit(self.code)
            killer.cancel()
            return

    def check(self, *_):
        self.sample()
        if self.code:
            raise InterruptedError("live read aborted by its watchdog")


@contextmanager
def guarded(source, limit, seconds, parent):
    bind_to_parent(parent)
    watch = Watch(source, limit, seconds, parent)
    watch.thread.start()
    try:
        watch.check()
        yield watch
    except Exception:
        if not watch.code:
            raise
    finally:
        watch.done.set()
        watch.thread.join()
        if watch.shm is not None:
            os.close(watch.shm)
    if watch.code:
        sys.exit(watch.code)


def add_guard_arguments(parser):
    parser.add_argument("--parent", type=int, default=0)
    parser.add_argument("--wal-limit", type=int, default=WAL_LIMIT)
    parser.add_argument("--seconds", type=float, default=0)
