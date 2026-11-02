import shutil
from pathlib import Path


def database_bytes(source):
    return sum(path.stat().st_size for path in (Path(source), Path(str(source) + "-wal")) if path.exists())


def require_space(directory, size, *, copies=2):
    free = shutil.disk_usage(directory).free
    required = size * copies
    if free < required:
        raise ValueError(f"snapshot space {free >> 20} MiB under the {required >> 20} MiB budget in {directory}; nothing stopped")
    return free
