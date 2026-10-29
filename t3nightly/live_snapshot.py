import argparse
import ctypes
import errno
import fcntl
import hashlib
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

from .io_priority import background_command


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


def clone_file(original, copy, timeout):
    if sys.platform != "darwin":
        subprocess.run(["cp", "--reflink=always", str(original), str(copy)], check=True, capture_output=True, timeout=min(10, timeout))
        return
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    libc.clonefile.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32)
    if libc.clonefile(os.fsencode(original), os.fsencode(copy), 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(original), None, str(copy))


def clone_database(source, destination, timeout):
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=30, isolation_level=None)) as reader:
        reader.execute("BEGIN")
        reader.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        try:
            for suffix in ("", "-wal"):
                original = Path(str(source) + suffix)
                if original.exists():
                    clone_file(original, Path(str(destination) + suffix), timeout)
        finally:
            reader.execute("ROLLBACK")


def fold_wal(destination):
    with closing(sqlite3.connect(destination, timeout=30, isolation_level=None)) as connection:
        if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] != 0:
            raise RuntimeError("snapshot WAL checkpoint is busy")
        connection.execute("PRAGMA journal_mode=DELETE").fetchone()
        connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
    for suffix in ("-wal", "-shm"):
        Path(str(destination) + suffix).unlink(missing_ok=True)


def backup_database(source, destination, timeout):
    end = time.monotonic() + timeout

    def progress(status, remaining, total):
        if time.monotonic() >= end:
            raise TimeoutError("stepwise snapshot backup exceeded its deadline")

    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=1)) as reader:
        with closing(sqlite3.connect(destination)) as writer:
            reader.backup(writer, pages=256, progress=progress, sleep=0.05)


def take(dest, *, home=None, timeout=1200):
    home = Path(home) if home is not None else Path.home() / ".t3"
    source = (home / "userdata/statev2.sqlite").resolve()
    destination = checked_path(dest, home)
    if destination == source:
        raise ValueError("snapshot destination must not be the source database")
    if not source.is_file():
        raise FileNotFoundError("no database to snapshot at %s" % source)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix=".snapshot-", dir=snapshot_root(home)) as raw:
        staged = Path(raw) / "statev2.sqlite"
        try:
            clone_database(source, staged, timeout)
            method = "apfs-clone" if sys.platform == "darwin" else "reflink"
        except (OSError, subprocess.CalledProcessError) as error:
            if sys.platform == "darwin":
                raise RuntimeError("APFS snapshot clone failed; refusing a live database backup") from error
            for path in Path(raw).iterdir():
                path.unlink()
            command = background_command([sys.executable, "-m", "t3nightly.live_snapshot", str(source), str(staged), str(timeout)])
            print("snapshot clone unavailable (%s); stepwise sqlite backup: %s" % (type(error).__name__, " ".join(command[:6])), file=sys.stderr, flush=True)
            env = dict(os.environ)
            root = str(Path(__file__).resolve().parent.parent)
            env["PYTHONPATH"] = root + os.pathsep + env.get("PYTHONPATH", "")
            subprocess.run(command, cwd=root, env=env, check=True, timeout=timeout)
            method = "background-stepwise-backup"
        fold_wal(staged)
        os.chmod(staged, 0o600)
        try:
            os.replace(staged, destination)
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
            with tempfile.TemporaryDirectory(prefix=".snapshot-publish-", dir=destination.parent) as publication:
                copied = Path(publication) / "statev2.sqlite"
                subprocess.run(background_command(["cp", str(staged), str(copied)]), check=True, capture_output=True, timeout=timeout)
                os.chmod(copied, 0o600)
                os.replace(copied, destination)
        os.utime(destination, None)
    print("snapshot %s: %s in %.3fs" % (method, destination, time.monotonic() - started), file=sys.stderr, flush=True)
    return destination


def for_run(key, *, home=None, timeout=1200):
    if not key:
        raise ValueError("snapshot run key must not be empty")
    home = Path(home) if home is not None else Path.home() / ".t3"
    root = snapshot_root(home)
    digest = hashlib.sha256(str(key).encode()).hexdigest()
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
        if not destination.is_file():
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
            if old == destination or old.stat().st_mtime >= cutoff:
                continue
            with checked_path(old.with_suffix(".lock"), home).open("a") as lease:
                try:
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                for suffix in ("", "-wal", "-shm"):
                    checked_path(Path(str(old) + suffix), home).unlink(missing_ok=True)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("timeout", type=float)
    args = parser.parse_args()
    backup_database(args.source, args.destination, args.timeout)
