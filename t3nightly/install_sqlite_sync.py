import shutil
import subprocess
import time
from pathlib import Path

from .io_priority import background_command
from .offbox_hosts import remote_rsync

SSH = Path(__file__).with_name("offbox-ssh")


def executable():
    found = shutil.which("sqlite3_rsync") or str(Path.home() / ".local/bin/sqlite3_rsync")
    if not Path(found).is_file():
        raise ValueError("sqlite3_rsync is not installed locally")
    return found


def sync(origin, replica, deadline, *, background=False, hang_guard=None):
    command = [executable(), str(origin), str(replica), "--exe", remote_rsync(origin, replica), "--ssh", str(SSH)]
    started = time.monotonic()
    result = subprocess.run(background_command(command) if background else command, capture_output=True, text=True, timeout=hang_guard if hang_guard is not None else max(1, deadline - time.monotonic()), check=False)
    if result.returncode:
        raise ValueError(f"sqlite3_rsync {origin} -> {replica} failed: {result.stderr.strip()[-300:]}")
    return time.monotonic() - started


