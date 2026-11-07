import os
from pathlib import Path


def launch_path(default):
    entries = os.environ.get("PATH", default).split(os.pathsep)
    cargo = Path.home() / ".cargo/bin"
    if cargo.is_dir() and str(cargo) not in entries:
        entries.insert(0, str(cargo))
    return os.pathsep.join(entries)
