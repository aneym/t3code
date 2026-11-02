import errno
import fcntl
import hashlib
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import ExitStack, closing, contextmanager
from pathlib import Path

from .io_priority import background_command
from . import live_read_guard as guard
from .snapshot_space import backup_seconds, clone_supported, database_bytes, require_space


MAX_AGE = 6 * 60 * 60
LEASES = {}


def checked_path(path, home):
    path = Path(path).expanduser().absolute()
    if ".." in path.parts:
        raise ValueError("snapshot path contains parent traversal")
    for parent in (*reversed(path.parents), path):
        if parent.is_symlink():
            raise ValueError("snapshot path must not contain a symlink: %s" % parent)
    for userdata in ((Path(home) / "userdata").resolve(), (Path.home() / ".t3/userdata").resolve()):
        if path == userdata or userdata in path.parents:
            raise ValueError("snapshot path must not be inside userdata")
    return path


def snapshot_root(home):
    root = checked_path(Path(home) / "snapshots", home)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


def read_snapshot(source, destination, timeout, method):
    seconds = min(timeout, 2 if method == "clone" else backup_seconds(database_bytes(source)))
    command = [sys.executable, "-m", "t3nightly.snapshot_reader", method, str(source), str(destination), *guard.guard_words(seconds)]
    command = background_command(command)
    root = str(Path(__file__).resolve().parent.parent)
    env = dict(os.environ, PYTHONPATH=root + os.pathsep + os.environ.get("PYTHONPATH", ""))
    result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=seconds + guard.GRACE_S + 5)
    if result.returncode:
        reason = result.stderr.strip()[-1000:]
        if result.returncode == guard.WAL_EXIT:
            raise guard.WalAbort(reason or "live WAL limit exceeded; snapshot refused")
        if result.returncode == guard.DEADLINE_EXIT:
            raise TimeoutError(reason or "live snapshot reader exceeded its deadline")
        raise subprocess.CalledProcessError(result.returncode, command, result.stdout, result.stderr)
    print("snapshot reader: " + result.stdout.strip(), file=sys.stderr, flush=True)


def fold_wal(destination):
    with closing(sqlite3.connect(destination, timeout=30, isolation_level=None)) as connection:
        if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] != 0:
            raise RuntimeError("snapshot WAL checkpoint is busy")
        connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
    for suffix in ("-wal", "-shm"):
        Path(str(destination) + suffix).unlink(missing_ok=True)


def _take(dest, *, home=None, timeout=1200):
    home = Path(home) if home is not None else Path.home() / ".t3"
    source = (home / "userdata/statev2.sqlite").resolve()
    destination = checked_path(dest, home)
    if destination == source:
        raise ValueError("snapshot destination must not be the source database")
    if not source.is_file():
        raise FileNotFoundError("no database to snapshot at %s" % source)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if timeout <= 0:
        raise ValueError("snapshot deadline must be positive")
    size = database_bytes(source)
    staging = snapshot_root(home)
    clone = clone_supported(staging, staging)
    if clone:
        require_space(staging, size, clone=True)
    require_space(destination.parent, size, clone=clone and destination.parent.stat().st_dev == staging.stat().st_dev)
    started = time.monotonic()
    end = started + timeout

    def remaining():
        left = end - time.monotonic()
        if left <= 0:
            raise TimeoutError("snapshot exceeded its deadline")
        return left

    with ExitStack() as stack:
        raw = stack.enter_context(tempfile.TemporaryDirectory(prefix=".snapshot-", dir=staging))
        staged = Path(raw) / "statev2.sqlite"
        try:
            if not clone:
                raise OSError("snapshot filesystem does not support cloning")
            read_snapshot(source, staged, remaining(), "clone")
            method = "apfs-clone" if sys.platform == "darwin" else "reflink"
        except (guard.WalAbort, TimeoutError, subprocess.TimeoutExpired):
            raise
        except (OSError, subprocess.CalledProcessError) as error:
            if sys.platform == "darwin":
                raise RuntimeError("APFS snapshot clone failed; refusing a live database backup") from error
            for path in Path(raw).iterdir():
                path.unlink()
            require_space(destination.parent, size)
            staged = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix=".snapshot-", dir=destination.parent))) / "statev2.sqlite"
            read_snapshot(source, staged, remaining(), "backup")
            method = "background-stepwise-backup"
        folded = time.monotonic()
        fold_wal(staged)
        print("snapshot WAL fold in %.3fs" % (time.monotonic() - folded), file=sys.stderr, flush=True)
        remaining()
        os.chmod(staged, 0o600)
        try:
            os.replace(staged, destination)
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
            with tempfile.TemporaryDirectory(prefix=".snapshot-publish-", dir=destination.parent) as publication:
                copied = Path(publication) / "statev2.sqlite"
                subprocess.run(background_command(["cp", str(staged), str(copied)]), check=True, capture_output=True, timeout=remaining())
                os.chmod(copied, 0o600)
                os.replace(copied, destination)
        os.utime(destination, None)
    print("snapshot %s: %s in %.3fs" % (method, destination, time.monotonic() - started), file=sys.stderr, flush=True)
    return destination


def take(dest, *, home=None, timeout=1200):
    end = time.monotonic() + timeout

    def attempt():
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("snapshot retry deadline expired")
        return _take(dest, home=home, timeout=remaining)

    return guard.retried(attempt, lambda wait, error: print(f"snapshot retry in {wait}s: {error}", file=sys.stderr, flush=True), waits=(1, 2), errors=(guard.WalAbort, TimeoutError, subprocess.TimeoutExpired))


def release(snapshot):
    snapshot = Path(snapshot)
    lease = LEASES.pop(snapshot, None)
    try:
        for suffix in ("", "-wal", "-shm"):
            Path(str(snapshot) + suffix).unlink(missing_ok=True)
        snapshot.with_suffix(".lock").unlink(missing_ok=True)
    finally:
        if lease is not None:
            lease.close()


@contextmanager
def leased_run(key, *, home=None, timeout=1200):
    snapshot = for_run(key, home=home, timeout=timeout)
    try:
        yield snapshot
    finally:
        release(snapshot)


def for_run(key, *, home=None, timeout=1200):
    if not key:
        raise ValueError("snapshot run key must not be empty")
    home = Path(home) if home is not None else Path.home() / ".t3"
    root = snapshot_root(home)
    digest = hashlib.sha256(str(key).encode()).hexdigest() + "-" + uuid.uuid4().hex
    destination = checked_path(root / ("statev2-run-%s.sqlite" % digest), home)
    end = time.monotonic() + timeout
    with checked_path(root / ".nightly-snapshot.lock", home).open("a") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= end:
                    raise TimeoutError("timed out waiting for the run snapshot")
                time.sleep(0.1)
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("run snapshot deadline expired")
        take(destination, home=home, timeout=remaining)
        if destination not in LEASES:
            lease = checked_path(destination.with_suffix(".lock"), home).open("a")
            fcntl.flock(lease, fcntl.LOCK_SH)
            LEASES[destination] = lease
        cutoff = time.time() - MAX_AGE
        for old in root.glob("statev2-run-*.sqlite"):
            checked_path(old, home)
            try:
                if old == destination or old.stat().st_mtime >= cutoff:
                    continue
            except FileNotFoundError:
                continue
            with checked_path(old.with_suffix(".lock"), home).open("a") as lease:
                try:
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                for suffix in ("", "-wal", "-shm"):
                    checked_path(Path(str(old) + suffix), home).unlink(missing_ok=True)
            old.with_suffix(".lock").unlink(missing_ok=True)
        for orphan in root.glob("statev2-run-*.lock"):
            if not orphan.with_suffix(".sqlite").exists():
                checked_path(orphan, home).unlink(missing_ok=True)
    return destination
