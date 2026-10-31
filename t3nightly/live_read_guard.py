import ctypes
import os
import signal
import struct
import sys
import threading
import time
from contextlib import contextmanager

WAL_LIMIT = 16 * 1024 * 1024
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


def guard_words(seconds):
    return ["--parent", str(os.getpid()), "--wal-limit", str(WAL_LIMIT), "--seconds", str(seconds)]


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
    def __init__(self, source, limit, seconds):
        shm = f"{source}-shm"
        self.shm = os.open(shm, os.O_RDONLY) if os.path.exists(shm) else None
        self.limit, self.deadline = limit, time.monotonic() + seconds
        self.connection, self.code = None, 0
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.watch, daemon=True)

    def watch(self):
        while not self.done.wait(POLL_S):
            wal = wal_frames(os.pread(self.shm, 48, 0)) if self.shm is not None else 0
            if wal >= self.limit:
                self.code, reason = WAL_EXIT, f"live WAL reached {wal / 2**20:.1f} MiB, over the {self.limit / 2**20:.1f} MiB limit"
            elif time.monotonic() >= self.deadline:
                self.code, reason = DEADLINE_EXIT, "live read passed its deadline"
            else:
                continue
            print(reason, file=sys.stderr, flush=True)
            try:
                self.connection.interrupt()
            except Exception:
                pass
            if not self.done.wait(GRACE_S):
                os._exit(self.code)
            return

    def check(self, *_):
        if self.code:
            raise InterruptedError("live read aborted by its watchdog")


@contextmanager
def guarded(source, limit, seconds, parent):
    bind_to_parent(parent)
    watch = Watch(source, limit, seconds)
    watch.thread.start()
    try:
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
