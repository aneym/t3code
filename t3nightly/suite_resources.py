import hashlib
import os
from contextlib import contextmanager

from .remote_shell import ssh_argv


CLEANUP = r'''
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

repo, requested, advisory_root = sys.argv[1:]
alias = Path(requested)
tree = alias.resolve()
root = Path(advisory_root).resolve()
if alias.is_symlink() or not alias.name.startswith("advisory-") or root not in tree.parents:
    raise RuntimeError(f"refusing unsafe advisory cleanup path: {requested}")
ancestors = {os.getpid()}
pid = os.getppid()
while pid > 1:
    ancestors.add(pid)
    try:
        pid = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
    except OSError:
        break
def holder():
    if not Path("/proc").is_dir():
        return None
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit() or int(proc.name) in ancestors:
            continue
        try:
            cwd = (proc / "cwd").resolve()
            if cwd == tree or tree in cwd.parents:
                return proc.name
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return None
deadline = time.monotonic() + 120
while (pid := holder()) and time.monotonic() < deadline:
    time.sleep(2)
if pid:
    raise RuntimeError(f"advisory worktree still in use by pid {pid} after 120s: {tree}")
listing = subprocess.run(["git", "-C", repo, "worktree", "list", "--porcelain"], capture_output=True, text=True, check=True).stdout
record = next((part for part in listing.split("\n\n") if part and Path(part.splitlines()[0].removeprefix("worktree ")).resolve() == tree), "")
branch = next((line.removeprefix("branch refs/heads/") for line in record.splitlines() if line.startswith("branch refs/heads/")), None)
if branch in ("main", "master"):
    raise RuntimeError(f"refusing to remove default branch {branch}")
if record:
    subprocess.run(["git", "-C", repo, "worktree", "remove", "--force", str(tree)], check=True)
if tree.exists():
    if not tree.name.startswith("advisory-") or (tree / ".git").exists() or any(child.name not in ("node_modules", ".advisory-tmp") for child in tree.iterdir()):
        raise RuntimeError(f"refusing to remove unregistered non-residual directory: {tree}")
    shutil.rmtree(tree)
if branch:
    subprocess.run(["git", "-C", repo, "branch", "-d", branch], check=True)
subprocess.run(["git", "-C", repo, "worktree", "prune"], check=True)
print(f"removed advisory worktree: {requested}")
'''


LOCK = r'''
import fcntl
import json
import pathlib
import select
import sys
import time

root = pathlib.Path("/srv/cow/t3-wt/.advisory-slots")
root.mkdir(parents=True, exist_ok=True)
slots = [(root / str(index)).open("a") for index in range(2)]
print(json.dumps({"state": "waiting", "at": time.time()}), flush=True)
while True:
    for index, handle in enumerate(slots):
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            continue
        print(json.dumps({"state": "acquired", "slot": index, "at": time.time()}), flush=True)
        sys.stdin.read()
        print(json.dumps({"state": "released", "slot": index, "at": time.time()}), flush=True)
        sys.exit(0)
    if select.select([sys.stdin], [], [], 0.2)[0] and not sys.stdin.read(1):
        sys.exit(0)
'''


class WorkerTerminated(RuntimeError):
    pass


TMP_ROOT = "/srv/cow/t3-wt/.advisory-tmp"
COW_LIMIT = 81.0


TMP = r'''
import json
import os
import shutil
import sys
import time
from pathlib import Path

mode, requested, root = sys.argv[1:]
tmp = Path(requested)
if tmp.is_symlink() or not tmp.name.startswith("advisory-") or tmp.parent != Path(root) or Path(root).resolve() != Path(root):
    raise RuntimeError(f"refusing unsafe advisory tmp path: {requested}")
prefix = str(tmp) + "/"
def size():
    total = 0
    for base, dirs, files in os.walk(tmp):
        for name in files:
            try:
                total += os.lstat(os.path.join(base, name)).st_blocks * 512
            except OSError:
                continue
    return total
def held():
    seen, total, holders = set(), 0, set()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            if (os.readlink(proc / "cwd") + "/").startswith(prefix):
                holders.add(int(proc.name))
            for fd in (proc / "fd").iterdir():
                target = os.readlink(fd)
                if not target.startswith(prefix):
                    continue
                holders.add(int(proc.name))
                if target.endswith(" (deleted)"):
                    info = os.stat(fd)
                    if (info.st_dev, info.st_ino) not in seen:
                        seen.add((info.st_dev, info.st_ino))
                        total += info.st_blocks * 512
        except OSError:
            continue
    return total, sorted(holders)
def cow():
    info = os.statvfs("/srv/cow")
    return info.f_bavail * info.f_frsize
if mode == "measure":
    print(json.dumps({"bytes": size() if tmp.exists() else 0}))
    sys.exit(0)
before = {"cowAvail": cow(), "bytes": size() if tmp.exists() else 0}
before["heldDeleted"], holders = held()
deadline = time.monotonic() + 120
while holders and time.monotonic() < deadline:
    time.sleep(2)
    _, holders = held()
if holders:
    held_bytes, holders = held()
    print(json.dumps({"before": before, "after": {"cowAvail": cow(), "heldDeleted": held_bytes, "bytes": size(), "holders": holders, "exists": tmp.exists(), "kept": True}}))
    sys.exit(0)
shutil.rmtree(tmp, ignore_errors=True)
after_held, holders = held()
print(json.dumps({"before": before, "after": {"cowAvail": cow(), "heldDeleted": after_held, "holders": holders, "exists": tmp.exists()}}))
'''


COW_GATE = r'''
import json
import os
import sys
import time

limit, wait = float(sys.argv[1]), float(sys.argv[2])
deadline = time.monotonic() + wait
while True:
    info = os.statvfs("/srv/cow")
    used = 100 * (info.f_blocks - info.f_bfree) / info.f_blocks
    print(json.dumps({"cowUsedPercent": round(used, 3), "at": time.time()}), flush=True)
    if used < limit:
        sys.exit(0)
    if time.monotonic() >= deadline:
        sys.exit(3)
    time.sleep(30)
'''


def job_tmp(tree):
    return f"{TMP_ROOT}/advisory-{hashlib.sha256(os.path.normpath(tree).encode()).hexdigest()[:16]}"


@contextmanager
def host_slot(host, tree, log):
    import json
    import shlex
    import subprocess
    import time

    if host != "ax42":
        yield None
        return
    process = subprocess.Popen([*ssh_argv(host, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', multiplex=False), shlex.join(["python3", "-c", LOCK])], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
    started = time.monotonic()
    try:
        for line in process.stdout:
            log.write(line)
            log.flush()
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict) and record.get("state") == "acquired":
                yield {"slot": record["slot"], "waitSeconds": round(time.monotonic() - started, 3)}
                return
        raise RuntimeError(f"host slot connection ended before acquisition: {host}")
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.write(process.stdout.read())


@contextmanager
def worker_signals():
    import signal

    def terminate(signum, frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise WorkerTerminated(f"advisory worker received signal {signum}")

    previous = signal.signal(signal.SIGTERM, terminate)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)
