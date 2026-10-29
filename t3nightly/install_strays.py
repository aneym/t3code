import fcntl
import os
import re
import select
import signal
import struct
import subprocess
import sys
import time
from pathlib import Path

MAX_REAPS = 3
TERM_WAIT_S = 30
KILL_WAIT_S = 5
LAUNCH_SKEW_S = 10
SQLITE_SHARED_FIRST = 0x40000002
SQLITE_SHARED_SIZE = 510


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


def process_started(pid):
    if sys.platform == "darwin":
        result = subprocess.run(["ps", "-o", "lstart=", "-p", pid], capture_output=True, text=True, check=False, timeout=15, env={**os.environ, "LC_ALL": "C"})
        value = " ".join(result.stdout.split())
        return time.mktime(time.strptime(value, "%a %b %d %H:%M:%S %Y")) if value else None
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    except FileNotFoundError:
        return None
    boot = next(int(line.split()[1]) for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime "))
    return boot + int(fields[19]) / os.sysconf("SC_CLK_TCK")


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


def lock_holder(path):
    if sys.platform == "darwin":
        try:
            descriptor = os.open(path, os.O_RDONLY)
        except FileNotFoundError:
            return None
        try:
            query = struct.pack("qqihh", SQLITE_SHARED_FIRST, SQLITE_SHARED_SIZE, 0, fcntl.F_RDLCK, os.SEEK_SET)
            _, _, holder, kind, _ = struct.unpack("qqihh", fcntl.fcntl(descriptor, fcntl.F_GETLK, query))
        finally:
            os.close(descriptor)
        return str(holder) if kind == fcntl.F_WRLCK else None
    try:
        info = os.stat(path)
        locks = Path("/proc/locks").read_text().splitlines()
    except FileNotFoundError:
        return None
    device = f"{os.major(info.st_dev):02x}:{os.minor(info.st_dev):02x}:{info.st_ino}"
    holders = {fields[3] for fields in (line.split()[1:] for line in locks) if len(fields) > 4 and fields[2] == "WRITE" and fields[4] == device}
    return holders.pop() if len(holders) == 1 else None


def owns_lock(pid, path):
    return lock_holder(path) == pid


def serves_home(argv, home):
    if "serve" not in argv or "--base-dir" not in argv:
        return False
    index = argv.index("--base-dir")
    return index + 1 < len(argv) and Path(argv[index + 1]).resolve() == home.resolve()


def launched_pid(launch):
    try:
        pid_file = launch / "pid"
        pid = pid_file.read_text().strip()
        launched = pid_file.stat().st_mtime
    except (FileNotFoundError, NotADirectoryError):
        return None
    if not pid.isdigit() or int(pid) <= 1:
        return None
    started = process_started(pid)
    return pid if started is not None and abs(started - launched) <= LAUNCH_SKEW_S else None


def logging_holder(launch, lock):
    pid = lock_holder(lock)
    if pid is None or not pid.isdigit() or int(pid) <= 1:
        return None
    return pid if holds(pid, launch / "server.log") else None


def identify(run, launch):
    try:
        marker = (launch / "managed").read_text().strip()
    except (FileNotFoundError, NotADirectoryError):
        return None
    if marker != "managed":
        return None
    lock = run.db.parent / "server-owner.sqlite"
    pid = launched_pid(launch) or logging_holder(launch, lock)
    if pid is None:
        return None
    started = process_started(pid)
    argv = process_argv(pid)
    if started is None or process_uid(pid) != os.getuid() or not serves_home(argv, run.home):
        return None
    on_service_port = pid in port_listeners(run.args.port)
    lock_owner = holds(pid, lock) and owns_lock(pid, lock)
    if not (on_service_port or lock_owner):
        return None
    return {"pid": pid, "argv": argv, "launchDir": str(launch), "started": started}


def managed_strays(run):
    root = run.home / "ssh-launch"
    if not root.is_dir():
        return []
    return [stray for stray in (identify(run, launch) for launch in sorted(root.iterdir())) if stray]


def same(run, stray):
    current = identify(run, Path(stray["launchDir"]))
    return current is not None and current["pid"] == stray["pid"] and current["argv"] == stray["argv"] and current["started"] == stray["started"]


def gone(pid, stray, seconds):
    end = time.monotonic() + seconds
    while True:
        if process_started(pid) != stray["started"]:
            return True
        if time.monotonic() >= end:
            return False
        time.sleep(0.5)


class ProcessWatch:
    def __init__(self, pid):
        self.queue = select.kqueue()
        try:
            self.queue.control([select.kevent(int(pid), select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_ONESHOT, select.KQ_NOTE_EXIT)], 0, 0)
        except OSError:
            self.queue.close()
            raise ProcessLookupError(pid)
        self.exited = False

    def gone(self):
        self.exited = self.exited or bool(self.queue.control(None, 1, 0))
        return self.exited

    def close(self):
        self.queue.close()


def bound(pid):
    try:
        return ProcessWatch(pid) if sys.platform == "darwin" else os.pidfd_open(int(pid))
    except ProcessLookupError:
        return -1


def send(run, pid, handle, stray, sig):
    if process_started(pid) != stray["started"] or process_argv(pid) != stray["argv"]:
        raise ValueError("managed ssh-launch server identity changed before signal")
    try:
        if isinstance(handle, ProcessWatch):
            if handle.gone():
                run.step("hard-reap-skip-exited", pid=pid, signal=sig.name, launchDir=stray["launchDir"])
                return
            os.kill(int(pid), sig)
        else:
            signal.pidfd_send_signal(handle, sig)
    except ProcessLookupError:
        pass


def reap(run, stray):
    pid = stray["pid"]
    handle = bound(pid)
    if handle == -1:
        return False
    try:
        if not same(run, stray):
            return False
        send(run, pid, handle, stray, signal.SIGTERM)
        signalled = "SIGTERM"
        if not gone(pid, stray, TERM_WAIT_S):
            send(run, pid, handle, stray, signal.SIGKILL)
            signalled = "SIGKILL"
            if not gone(pid, stray, KILL_WAIT_S):
                raise ValueError("managed ssh-launch server did not exit")
    finally:
        if isinstance(handle, ProcessWatch):
            handle.close()
        else:
            os.close(handle)
    entry = {key: stray[key] for key in ("pid", "argv", "launchDir")} | {"signal": signalled, "platformBinding": "kqueue-checked" if sys.platform == "darwin" else "pidfd", "at": time.time()}
    run.reaped.append(entry)
    run.step("hard-reap-ssh-launch", **entry)
    return True


def reap_strays(run, attempt):
    strays = managed_strays(run)
    if strays and attempt >= MAX_REAPS:
        raise ValueError("managed ssh-launch server kept taking the T3 home")
    return any([reap(run, stray) for stray in strays])
