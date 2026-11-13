import re
import shutil
import subprocess
import time
from pathlib import Path

from .io_priority import background_command
from .offbox_hosts import remote_rsync

SSH = Path(__file__).with_name("offbox-ssh")
UPDATES = re.compile(r"page updates: (\d+)")


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


def local_command(origin, replica, *, background=False):
    command = [executable(), str(origin), str(replica), "-vvv"]
    return background_command(command) if background else command


def page_updates(origin, replica, code, output):
    if code:
        raise ValueError(f"sqlite3_rsync {origin} -> {replica} exited {code}: {output.strip()[-300:]}")
    found = UPDATES.search(output)
    if not found:
        raise ValueError(f"sqlite3_rsync {origin} -> {replica} reported no page-update count")
    return int(found.group(1))


def local_sync(origin, replica, deadline):
    started = time.monotonic()
    timeout = None if deadline is None else max(0.001, deadline - time.monotonic())
    result = subprocess.run(local_command(origin, replica), capture_output=True, text=True, timeout=timeout, check=False)
    return {"pageUpdates": page_updates(origin, replica, result.returncode, result.stdout + result.stderr), "seconds": round(time.monotonic() - started, 3)}
