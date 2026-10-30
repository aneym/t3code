import ctypes
import errno
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid
from pathlib import Path

from .release_signatures import verify_cli


def mark_update_restart(home):
    runtime = Path(home) / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".desktop-update-restart-", dir=runtime)
    os.close(fd)
    staged = Path(name)
    try:
        os.replace(staged, runtime / "desktop-update-restart")
    finally:
        staged.unlink(missing_ok=True)


def exchange(left, right):
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        result = library.renamex_np(os.fsencode(left), os.fsencode(right), 2)
    else:
        result = library.renameat2(-100, os.fsencode(left), -100, os.fsencode(right), 2)
    if result:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))


def activate(staged, target):
    verify_cli(staged / "t3")
    if target.exists() or target.is_symlink():
        exchange(staged, target)
        backup = target.with_name(f".{target.name}-rollback-{uuid.uuid4().hex}")
        try:
            os.replace(staged, backup)
        except OSError:
            exchange(staged, target)
            raise
        return backup
    os.replace(staged, target)
    return None


def stage_runtime(home, version, assets):
    platform = "darwin-arm64" if sys.platform == "darwin" else "linux-x64"
    archive = Path(assets) / f"t3-{version}-{platform}.tar.gz"
    versions = Path(home) / "runtime" / "versions"
    versions.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".verified-", dir=versions) as raw:
        with tarfile.open(archive, "r:gz") as bundle:
            bundle.extractall(raw, filter="data")
        roots = [path for path in Path(raw).iterdir() if not path.name.startswith("._")]
        if len(roots) != 1 or not roots[0].is_dir():
            raise ValueError("runtime archive must contain one directory")
        staged = roots[0]
        verify_cli(staged / "t3")
        (staged / ".install-complete").write_text(version + "\n")
        from .rehearsal_storage import bind_runtime, enabled, publish

        if enabled(home):
            shared = publish(staged, move=True)
            staged = Path(raw) / ".shared-runtime"
            bind_runtime(home, version, shared, staged)
        activate(staged, versions / version)
    return versions / version / "t3"


def pin_runtime(home, version):
    runtime = Path(home) / "runtime"
    source = runtime / "versions" / version
    verify_cli(source / "t3")
    with tempfile.TemporaryDirectory(prefix=".launcher-", dir=runtime) as raw:
        staged = Path(raw) / "launcher"
        if sys.platform == "darwin":
            subprocess.run(["cp", "-c", "-R", str(source), str(staged)], check=True, timeout=240)
        else:
            shutil.copytree(source, staged, symlinks=True)
        backup = activate(staged, runtime / "launcher")
    return runtime / "launcher" / "t3", backup


def link_or_copy(source, destination):
    try:
        os.link(source, destination)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        shutil.copy2(source, destination)


def link_tree(source, destination):
    shutil.copytree(source, destination, symlinks=True, copy_function=link_or_copy)


def retain_runtime(home, version, store):
    source = Path(home) / "runtime" / "versions" / version
    verify_cli(source / "t3")
    store.mkdir(parents=True, exist_ok=True)
    retained = store / version
    if retained.is_symlink():
        retained.unlink()
    elif retained.exists():
        shutil.rmtree(retained)
    from .rehearsal_storage import enabled

    if enabled(home):
        refs = Path(home) / "runtime/rehearsal-runtime-refs.json"
        shared = Path(json.loads(refs.read_text())[version]) if refs.exists() else source.resolve()
        from .rehearsal_storage import store_root

        if shared.resolve().parent != store_root():
            raise ValueError("retained rehearsal runtime reference escaped its shared store")
        retained.symlink_to(shared, target_is_directory=True)
    else:
        link_tree(source, retained)
    return retained


def restore_runtime(home, version, store):
    target = Path(home) / "runtime" / "versions" / version
    if (target / "t3").exists():
        return False
    retained = store / version
    verify_cli(retained / "t3")
    with tempfile.TemporaryDirectory(prefix=".restore-", dir=target.parent) as raw:
        staged = Path(raw) / version
        from .rehearsal_storage import enabled

        if enabled(home):
            if sys.platform == "darwin":
                from .rehearsal_storage import clone_tree

                clone_tree(retained.resolve(), staged)
            else:
                staged.symlink_to(retained.resolve(), target_is_directory=True)
        else:
            link_tree(retained, staged)
        os.replace(staged, target)
    return True
