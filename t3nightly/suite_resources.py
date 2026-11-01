from contextlib import contextmanager


CLEANUP = r'''
import os
import shutil
import subprocess
import sys
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
if Path("/proc").is_dir():
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit() or int(proc.name) in ancestors:
            continue
        try:
            cwd = (proc / "cwd").resolve()
            args = (proc / "cmdline").read_bytes().decode(errors="replace")
            if cwd == tree or tree in cwd.parents or str(alias) in args or str(tree) in args:
                raise RuntimeError(f"advisory worktree still in use by pid {proc.name}: {tree}")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
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


def cache_exports(host):
    if host != "ax42":
        return "true"
    return "{ mkdir -p /srv/cow/t3-wt/.advisory-cache/pnpm /srv/cow/t3-wt/.advisory-tmp && export TMPDIR=/srv/cow/t3-wt/.advisory-tmp XDG_CACHE_HOME=/srv/cow/t3-wt/.advisory-cache PNPM_CONFIG_CACHE_DIR=/srv/cow/t3-wt/.advisory-cache/pnpm; }"


@contextmanager
def host_slot(host, tree, log):
    import json
    import shlex
    import subprocess
    import time

    if host != "ax42":
        yield None
        return
    process = subprocess.Popen(["ssh", "-o", "BatchMode=yes", host, shlex.join(["python3", "-c", LOCK])], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
    started = time.monotonic()
    try:
        for line in process.stdout:
            log.write(line)
            log.flush()
            record = json.loads(line)
            if record["state"] == "acquired":
                yield {"slot": record["slot"], "waitSeconds": round(time.monotonic() - started, 3)}
                return
        raise RuntimeError(f"host slot connection ended before acquisition: {host}")
    finally:
        process.stdin.close()
        for line in process.stdout:
            log.write(line)
        process.wait(timeout=30)


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
