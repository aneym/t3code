import fcntl
import json
import os
import sqlite3
from contextlib import ExitStack, closing, contextmanager
from pathlib import Path

from t3nightly.install_storage import record_payload


def contained(root, path):
    root = Path(root).resolve()
    path = Path(path)
    if path.resolve() == root or not path.resolve().is_relative_to(root):
        raise ValueError(f"payload escapes retention root: {path}")
    if path.is_symlink():
        raise ValueError(f"payload cannot be a symlink: {path}")
    return path


@contextmanager
def payload_lock(root, path):
    lock = contained(root, Path(str(path) + ".lock"))
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True


def discard(root, path, state, role):
    path = contained(root, path)
    if not path.exists():
        return
    if path.is_dir():
        for child in path.iterdir():
            discard(root, child, state, role)
        path.rmdir()
        record_payload(state, role, path, bytes=0)
    else:
        size = path.stat().st_size
        path.unlink()
        record_payload(state, role, path, bytes=size)


def discard_snapshot(root, path, state, role):
    for suffix in (
        "",
        "-wal",
        "-shm",
        "-journal",
        ".partial",
        ".partial-wal",
        ".partial-shm",
        ".partial-journal",
    ):
        discard(root, Path(str(path) + suffix), state, role)


def collect_snapshots(root, current, state):
    names = set()
    for path in root.glob("install-read-snapshot-*.sqlite*"):
        name, separator, _ = path.name.partition(".sqlite")
        if separator:
            names.add(root / (name + ".sqlite"))
    for path in sorted(names):
        if path == current:
            continue
        with payload_lock(root, path) as acquired:
            if acquired:
                discard_snapshot(root, path, state, "discard-stale-read-snapshot")


def complete_backup(root, path, version):
    contained(root, path)
    marker = contained(root, path / "payload.json")
    if marker.exists():
        try:
            return json.loads(marker.read_text()) == {
                "version": version,
                "complete": True,
            }
        except (OSError, ValueError):
            return False
    db = contained(root, path / "statev2.sqlite")
    if not db.is_file():
        return False
    try:
        with closing(sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True)) as connection:
            return connection.execute("PRAGMA quick_check").fetchone() == ("ok",)
    except sqlite3.DatabaseError:
        return False


def backup_candidates(root, version):
    return sorted(
        (
            path
            for path in root.iterdir()
            if path.is_dir() and path.name.partition("-")[2] == version
        ),
        key=lambda path: path.name,
    )


def prune_backups(root, version, keep, current, state):
    if keep < 1:
        raise ValueError("backup keep must be at least one")
    with payload_lock(root, root / "retention") as acquired:
        if not acquired:
            return
        with ExitStack() as locks:
            complete = []
            held = 0
            for path in backup_candidates(root, version):
                if path == current:
                    continue
                if not locks.enter_context(payload_lock(root, path)):
                    held += 1
                    continue
                if complete_backup(root, path, version):
                    complete.append(path)
            count = len(complete) + held + 1
            for path in complete:
                if count <= keep:
                    break
                if path.name >= current.name:
                    continue
                discard(root, path, state, "prune-rollback-backup")
                count -= 1


class Payloads:
    def __init__(self):
        self.locks = ExitStack()

    def hold(self, root, path):
        if not self.locks.enter_context(payload_lock(root, path)):
            raise ValueError(f"payload already owned: {path}")


@contextmanager
def payload_lifecycle(run):
    payloads = Payloads()
    run.payloads = payloads
    owned = False
    try:
        payloads.hold(run.snapshots, run.snapshot)
        owned = True
        collect_snapshots(run.snapshots, run.snapshot, run.state)
        yield
    finally:
        try:
            if owned:
                discard_snapshot(
                    run.snapshots, run.snapshot, run.state, "discard-run-read-snapshot"
                )
                run.snapshot_ready = False
        finally:
            payloads.locks.close()
