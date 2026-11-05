import os
import shutil
import sqlite3
import sys
import time
from contextlib import closing
from pathlib import Path


def database_copy(source, target, deadline):
    def progress(status, remaining, total):
        if time.monotonic() >= deadline:
            raise TimeoutError("rollback backup exceeded its deadline")

    with closing(sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)) as reader:
        with closing(sqlite3.connect(target)) as writer:
            reader.backup(writer, pages=4096, progress=progress)


def copy_rate(path):
    if sys.platform == "darwin":
        return 80_000_000
    device = os.stat(path).st_dev
    rotational = Path(f"/sys/dev/block/{os.major(device)}:{os.minor(device)}/queue/rotational")
    try:
        spinning = rotational.read_text().strip() == "1"
    except OSError:
        spinning = True
    return 15_000_000 if spinning else 40_000_000


def require_space(root, size, *, clone=False):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    required = size * 2 if clone else size + max(size // 10, 512 * 1024 * 1024)
    if sys.platform == "darwin" and root.resolve().is_relative_to((Path.home() / ".t3nightly").resolve()):
        required += 40 * 1024**3
    free = shutil.disk_usage(root).free
    if free < required:
        raise ValueError(f"insufficient rollback backup space on {root}; free={free} required={required} bytes (source={size}, clone={clone}, includes 40 GiB floor on internal nightly storage)")


