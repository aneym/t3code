import fcntl
import os
import stat
import tempfile
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def readiness_lock(run):
    run = Path(run)
    run.mkdir(parents=True, exist_ok=True)
    with (run / ".readiness-refresh.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield run / "readiness.json"


def atomic_write(path, content):
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)
