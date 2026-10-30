import errno
import fcntl
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from contextlib import closing
from pathlib import Path


def clone_file(source, destination):
    command = ["cp", "-c", str(source), str(destination)] if sys.platform == "darwin" else ["cp", "--reflink=always", str(source), str(destination)]
    result = subprocess.run(command, capture_output=True, timeout=120)
    if result.returncode == 0:
        return "apfs-clone" if sys.platform == "darwin" else "reflink"
    Path(destination).unlink(missing_ok=True)
    shutil.copy2(source, destination)
    return "copy"


def clone_tree(source, destination):
    if sys.platform == "darwin":
        result = subprocess.run(["cp", "-c", "-R", str(source), str(destination)], capture_output=True, timeout=240)
        if result.returncode == 0:
            return "apfs-clone"
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source, destination, symlinks=True)
        return "copy"
    methods = set()

    def link_or_clone(source_file, target_file):
        try:
            os.link(source_file, target_file)
            methods.add("hardlink")
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
            methods.add(clone_file(source_file, target_file))
        return target_file

    shutil.copytree(source, destination, symlinks=True, copy_function=link_or_clone)
    return "+".join(sorted(methods)) or "hardlink"


def tree_digest(source):
    digest = hashlib.sha256()
    for path in sorted(source.rglob("*")):
        if path.name == ".install-complete":
            continue
        digest.update(str(path.relative_to(source)).encode() + b"\0")
        digest.update(str(path.lstat().st_mode & 0o177777).encode() + b"\0")
        if path.is_symlink():
            digest.update(os.readlink(path).encode())
        elif path.is_file():
            with path.open("rb") as stream:
                digest.update(hashlib.file_digest(stream, "sha256").digest())
    return digest.hexdigest()


def store_root():
    root = Path.home() / ".t3nightly/rehearsal-runtimes"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink():
        raise ValueError("rehearsal runtime store must not be a symlink")
    return root.resolve()


def publish(source, move=False):
    source = Path(source).resolve()
    root = store_root()
    with (root / ".store.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        key = tree_digest(source)
        if source.parent == root and source.name != key:
            raise ValueError("shared rehearsal source content drifted")
        target = root / key
        if target.exists():
            if target.is_symlink() or tree_digest(target) != key:
                raise ValueError("shared rehearsal runtime content drifted")
        else:
            with tempfile.TemporaryDirectory(prefix=".runtime-", dir=root) as raw:
                staged = Path(raw) / key
                if move and source.stat().st_dev == root.stat().st_dev:
                    os.replace(source, staged)
                else:
                    clone_tree(source, staged)
                os.replace(staged, target)
        renew_publication(root, key)
    return target


def renew_publication(root, key):
    metadata = root / ".published"
    metadata.mkdir(exist_ok=True, mode=0o700)
    marker = metadata / key
    if metadata.is_symlink() or marker.is_symlink():
        raise ValueError("rehearsal publication metadata must not be a symlink")
    marker.touch()


def enabled(home):
    path = Path(home) / "runtime/rehearsal-storage.json"
    try:
        marker = json.loads(path.read_text())
    except FileNotFoundError:
        return False
    if marker != {"schema": 1, "store": str(store_root())}:
        raise ValueError("invalid isolated rehearsal storage marker")
    from .install_policy import refuse_probe

    refuse_probe(home, 19499, "t3-rehearsal-storage")
    return True


def owns(home, binary):
    binary = Path(binary).resolve()
    runtime = Path(home) / "runtime"
    if binary.is_relative_to(runtime):
        return True
    if not enabled(home):
        return False
    return any(path.is_symlink() and binary == (path / "t3").resolve() and path.resolve().parent == store_root() for path in (runtime / "versions").iterdir())


def seed_database(seed, destination):
    root = store_root() / "seeds"
    root.mkdir(exist_ok=True)
    with (store_root() / ".store.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix=".snapshot-", dir=root) as raw:
            snapshot = Path(raw) / "statev2.sqlite"
            with closing(sqlite3.connect(f"file:{seed.resolve()}?mode=ro", uri=True)) as source, closing(sqlite3.connect(snapshot)) as target:
                source.backup(target)
            with snapshot.open("rb") as stream:
                key = hashlib.file_digest(stream, "sha256").hexdigest()
            cached = root / (key + ".sqlite")
            if not cached.exists():
                os.replace(snapshot, cached)
            renew_publication(store_root(), cached.name)
            method = clone_file(cached, destination)
    return {"method": method, "snapshot": str(cached), "sha256": key}


def prepare(sandbox):
    root = store_root()
    runtime = sandbox.home / "runtime"
    (runtime / "rehearsal-storage.json").write_text(json.dumps({"schema": 1, "store": str(root)}) + "\n")
    shared = publish(sandbox.old)
    (runtime / "versions" / sandbox.old.name).symlink_to(shared, target_is_directory=True)
    launcher_method = clone_tree(shared, sandbox.cli.parent)
    seed = seed_database(sandbox.args.seed, sandbox.db)
    (runtime / "rehearsal-seed.json").write_text(json.dumps(seed) + "\n")
    receipt = {"runtime": str(shared), "versionMethod": "symlink", "launcherMethod": launcher_method, "seed": seed}
    (sandbox.evidence / "storage.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt
