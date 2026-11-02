import fcntl
import hashlib
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from .release_hold_quarantine import clear_quarantine, pending
from .release_hold_state import event, read, save
from .release_hold_watch import exit_worker, release


def stop_worker(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def expire(config, root):
    row = read(root / "state.json", {"host": config["host"]})
    release(config, root, row, "expired")
    clear_quarantine(config, root, row)
    save(root, row, watcher="exited")
    event(root, "expired", quarantinePending=pending(row), warning=pending(row))
    event(root, "keeper-exit", reason="expired")


def supervise(root):
    root = Path(root).resolve()
    config = read(root / "config.json")
    with (root / "keeper.lock").open("a") as owner:
        try:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        expires = read(root / "deadline.json")["expiresAt"]
        signal.signal(signal.SIGTERM, exit_worker)
        lock_root = Path(config["lockRoot"])
        lock_root.mkdir(parents=True, exist_ok=True)
        resource = "live-install:" + config["host"]
        with (lock_root / hashlib.sha256(resource.encode()).hexdigest()).open("a") as handle:
            process = None
            delay = 1
            try:
                while time.time() < expires:
                    command = [sys.executable, "-B", str(Path(__file__).with_name("release-holds")),
                               "watch", str(root), str(handle.fileno())]
                    started = time.monotonic()
                    process = subprocess.Popen(command, pass_fds=(handle.fileno(),))
                    try:
                        code = process.wait(timeout=max(0, expires - time.time()))
                    except subprocess.TimeoutExpired:
                        break
                    row = read(root / "state.json", {})
                    if code == 0 and row.get("watcher") == "exited":
                        return 0
                    if time.monotonic() - started >= 5:
                        delay = 1
                    event(root, "worker-restart", exit=code, pid=process.pid, keeperPid=os.getpid(), backoffSeconds=delay)
                    time.sleep(min(delay, max(0, expires - time.time())))
                    delay = min(delay * 2, 30)
            finally:
                stop_worker(process)
                fcntl.flock(handle, fcntl.LOCK_UN)
            expire(config, root)
            return 0
