import os
import signal
import subprocess
import time
from pathlib import Path


def process_start(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True, check=False)
    if result.returncode != 0 or not result.stdout.strip():
        raise ProcessLookupError("process %d is gone" % pid)
    return result.stdout.strip()


def process_cwd(pid):
    result = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True, check=False)
    for line in result.stdout.splitlines():
        if line.startswith("n"):
            return line[1:]
    raise ValueError("cannot read cwd for process %d" % pid)


def live_identity(state):
    try:
        pid = int(state["pid"])
        if pid <= 0 or int(state["pgid"]) <= 0:
            return None
        os.kill(pid, 0)
        if process_start(pid) != state["process_start"]:
            return None
        status = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True, check=False)
        if status.stdout.strip().startswith("Z"):
            return None
        if Path(process_cwd(pid)).resolve() != Path(state["worktree"]).resolve():
            raise ValueError("recorded process %d changed cwd" % pid)
        if os.getpgid(pid) != int(state["pgid"]):
            raise ValueError("recorded process %d changed process group" % pid)
        return pid
    except (OSError, ValueError, KeyError, TypeError):
        return None


def stop_recorded(pid, pgid, process_started, worktree):
    state = {"pid": pid, "pgid": pgid, "process_start": process_started, "worktree": str(worktree)}
    if live_identity(state) is None:
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            os.killpg(pgid, 0)
            time.sleep(0.2)
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        return


def refuse_listener(worktree):
    result = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-t"], capture_output=True, text=True, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError("cannot inspect dev listeners")
    for value in set(result.stdout.split()):
        pid = int(value)
        try:
            cwd = Path(process_cwd(pid)).resolve()
        except ValueError:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            raise
        if cwd == worktree or worktree in cwd.parents:
            raise ValueError("a dev listener already uses this worktree (PID %d)" % pid)
