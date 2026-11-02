import fcntl
import hashlib
import os
import subprocess
import sys
import time
from pathlib import Path

from .release_hold_state import event, read


def supervise(root):
    root = Path(root).resolve()
    config = read(root / "config.json")
    with (root / "keeper.lock").open("a") as owner:
        try:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        lock_root = Path(config["lockRoot"])
        lock_root.mkdir(parents=True, exist_ok=True)
        resource = "live-install:" + config["host"]
        with (lock_root / hashlib.sha256(resource.encode()).hexdigest()).open("a") as handle:
            while True:
                command = [sys.executable, "-B", str(Path(__file__).with_name("release-holds")),
                           "watch", str(root), str(handle.fileno())]
                process = subprocess.Popen(command, pass_fds=(handle.fileno(),))
                code = process.wait()
                row = read(root / "state.json", {})
                if code == 0 and row.get("watcher") == "exited":
                    return 0
                event(root, "worker-restart", exit=code, pid=process.pid, keeperPid=os.getpid())
                time.sleep(min(config["interval"], 1))
