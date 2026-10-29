import json
import os


def startup_path(run):
    path = run.home / "userdata" / "restart-handoff.json"
    for parent in (run.home, path.parent):
        if parent.is_symlink():
            raise ValueError("restart handoff parent cannot be a symlink")
    if path.exists() or path.is_symlink():
        raise ValueError("unconsumed startup handoff already exists")
    return path


def discard_owned(run, path, epoch):
    if path is None or not path.exists():
        return
    if path.is_symlink() or not path.is_file():
        raise ValueError("restart handoff cleanup refused a nonregular path")
    saved = json.loads(path.read_text())
    if saved.get("epoch") != epoch:
        raise ValueError("restart handoff cleanup refused another epoch")
    path.unlink()
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    run.step("discard-owned-startup-handoff", epoch=epoch)
