import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

MAX_REAPS = 3
TERM_WAIT_S = 30
KILL_WAIT_S = 5


def port_listeners(port):
    if sys.platform == "darwin":
        sockets = subprocess.run(["/usr/sbin/lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True, check=False, timeout=15)
        return set(sockets.stdout.split())
    sockets = subprocess.run(["ss", "-H", "-ltnp", f"sport = :{port}"], capture_output=True, text=True, check=True, timeout=15)
    return set(re.findall(r"pid=(\d+),", sockets.stdout))


def process_uid(pid):
    if sys.platform == "darwin":
        result = subprocess.run(["ps", "-o", "uid=", "-p", pid], capture_output=True, text=True, check=False, timeout=15)
        value = result.stdout.strip()
        return int(value) if value.isdigit() else None
    try:
        return os.stat(f"/proc/{pid}").st_uid
    except FileNotFoundError:
        return None


def process_argv(pid):
    if sys.platform == "darwin":
        result = subprocess.run(["ps", "-ww", "-o", "args=", "-p", pid], capture_output=True, text=True, check=False, timeout=15)
        return result.stdout.split()
    try:
        return [part for part in Path(f"/proc/{pid}/cmdline").read_bytes().decode(errors="replace").split("\0") if part]
    except FileNotFoundError:
        return []


def holds(pid, path):
    target = str(path.resolve())
    if sys.platform == "darwin":
        result = subprocess.run(["/usr/sbin/lsof", "-a", "-p", pid, "-Fn"], capture_output=True, text=True, check=False, timeout=15)
        return any(line[1:] == target for line in result.stdout.splitlines() if line.startswith("n"))
    try:
        descriptors = os.listdir(f"/proc/{pid}/fd")
    except (FileNotFoundError, PermissionError):
        return False
    for descriptor in descriptors:
        try:
            if os.readlink(f"/proc/{pid}/fd/{descriptor}") == target:
                return True
        except OSError:
            continue
    return False


def serves_home(argv, home):
    if "serve" not in argv or "--base-dir" not in argv:
        return False
    index = argv.index("--base-dir")
    return index + 1 < len(argv) and Path(argv[index + 1]).resolve() == home.resolve()


def managed_strays(run):
    root = run.home / "ssh-launch"
    if not root.is_dir():
        return []
    lock = run.db.parent / "server-owner.sqlite"
    listeners = port_listeners(run.args.port)
    strays = []
    for launch in sorted(root.iterdir()):
        try:
            marker = (launch / "managed").read_text().strip()
            pid = (launch / "pid").read_text().strip()
        except (FileNotFoundError, NotADirectoryError):
            continue
        if marker != "managed" or not pid.isdigit() or int(pid) <= 1:
            continue
        argv = process_argv(pid)
        if process_uid(pid) != os.getuid() or not serves_home(argv, run.home):
            continue
        if pid in listeners or holds(pid, lock):
            strays.append({"pid": pid, "argv": argv, "launchDir": str(launch)})
    return strays


def alive(pid):
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    return True


def wait_exit(pid, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if not alive(pid):
            return True
        time.sleep(0.5)
    return not alive(pid)


def reap(run, stray):
    pid = stray["pid"]
    os.kill(int(pid), signal.SIGTERM)
    signalled = "SIGTERM"
    if not wait_exit(pid, TERM_WAIT_S):
        if process_argv(pid) != stray["argv"]:
            raise ValueError("managed ssh-launch server identity changed before SIGKILL")
        os.kill(int(pid), signal.SIGKILL)
        signalled = "SIGKILL"
        if not wait_exit(pid, KILL_WAIT_S):
            raise ValueError("managed ssh-launch server did not exit")
    entry = {**stray, "signal": signalled, "at": time.time()}
    run.reaped.append(entry)
    run.step("hard-reap-ssh-launch", **entry)


def reap_strays(run, attempt):
    strays = managed_strays(run)
    if strays and attempt >= MAX_REAPS:
        raise ValueError("managed ssh-launch server kept taking the T3 home")
    for stray in strays:
        reap(run, stray)
    return bool(strays)
