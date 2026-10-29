import argparse
import fcntl
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

from .io_priority import background_command
from .live_snapshot import checked_path, snapshot_root


IDENTITY_KEYS = {
    "orchestration_v2_projection_threads": "thread_id",
    "orchestration_v2_projection_messages": "message_id",
}


def read(snapshot):
    with closing(sqlite3.connect(snapshot.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
        return {
            table: {row[0] for row in connection.execute(f"SELECT {key} FROM {table}")}
            for table, key in IDENTITY_KEYS.items()
        }


def copy(source, destination, timeout):
    started = time.monotonic()
    with closing(sqlite3.connect(destination, uri=True, timeout=min(timeout, 30))) as connection:
        connection.set_progress_handler(lambda: int(time.monotonic() - started >= timeout), 10000)
        connection.execute("ATTACH DATABASE ? AS live", (source.resolve().as_uri() + "?mode=ro",))
        with connection:
            for table, key in IDENTITY_KEYS.items():
                connection.execute(f"CREATE TABLE {table} ({key} TEXT)")
                connection.execute(f"INSERT INTO {table} SELECT {key} FROM live.{table}")
    os.chmod(destination, 0o600)


def merge(fresh, destination):
    with closing(sqlite3.connect(destination)) as connection:
        connection.execute("ATTACH DATABASE ? AS fresh", (fresh.resolve().as_uri() + "?mode=ro",))
        with connection:
            for table, key in IDENTITY_KEYS.items():
                connection.execute(f"INSERT INTO main.{table} SELECT {key} FROM fresh.{table} WHERE {key} NOT IN (SELECT {key} FROM main.{table})")
        connection.execute("DETACH DATABASE fresh")


def take(destination, *, home, timeout=1200):
    destination = checked_path(destination, home)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    source = Path(home).resolve() / "userdata/statev2.sqlite"
    with tempfile.TemporaryDirectory(prefix=".identity-build-", dir=destination.parent) as raw:
        staged = Path(raw) / "statev2.sqlite"
        root = str(Path(__file__).resolve().parent.parent)
        command = background_command([sys.executable, "-m", "t3nightly.identity_snapshot", str(source), str(staged), str(timeout)])
        env = dict(os.environ, PYTHONPATH=root)
        subprocess.run(command, cwd=root, env=env, check=True, timeout=timeout)
        os.replace(staged, destination)
    return destination


def for_version(version, *, home, timeout=1200):
    if not version:
        raise ValueError("identity snapshot version must not be empty")
    root = snapshot_root(home)
    digest = hashlib.sha256(str(version).encode()).hexdigest()
    destination = checked_path(root / f"identity-version-{digest}.sqlite", home)
    started = time.monotonic()
    with checked_path(root / ".identity-snapshot.lock", home).open("a") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() - started >= timeout:
                    raise TimeoutError("identity snapshot lock deadline exceeded")
                time.sleep(0.1)
        for old in root.glob("identity-version-*.sqlite"):
            if old != destination:
                checked_path(old, home).unlink()
        reused = destination.is_file()
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError("identity snapshot deadline exceeded")
        if reused:
            fresh = checked_path(root / f"identity-fresh-{digest}.sqlite", home)
            try:
                take(fresh, home=home, timeout=remaining)
                merge(fresh, destination)
            finally:
                fresh.unlink(missing_ok=True)
        else:
            take(destination, home=home, timeout=remaining)
        print(json.dumps({"identitySnapshot": "extended" if reused else "created", "seconds": round(time.monotonic() - started, 6), "bytes": destination.stat().st_size}), file=sys.stderr, flush=True)
    return destination


def finish(version, *, home):
    root = snapshot_root(home)
    digest = hashlib.sha256(str(version).encode()).hexdigest()
    with checked_path(root / ".identity-snapshot.lock", home).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        checked_path(root / f"identity-version-{digest}.sqlite", home).unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("timeout", type=float)
    args = parser.parse_args()
    started = time.monotonic()
    copy(args.source, args.destination, args.timeout)
    io = Path("/proc/self/io")
    counters = dict(line.split(": ", 1) for line in io.read_text().splitlines()) if io.exists() else {}
    print(json.dumps({"identityCopySeconds": round(time.monotonic() - started, 6), "bytes": args.destination.stat().st_size, "io": counters}), file=sys.stderr, flush=True)
