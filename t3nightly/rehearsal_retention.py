import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from .hot_swap_retention import kib

SUCCESS = ("PASS", "COMPATIBILITY-PROBE", "ROLLBACK-PROOF")
APPROVAL = "alex-studio-disk-cleanup-2026-10-25"
FAST_HOST = re.compile(r"rehearsal-fast-\d+-([a-z0-9]+)-[0-9a-f]{12}(?:-rollback)?")


def nightly_root():
    return (Path.home() / ".t3nightly").resolve()


def finished(path):
    try:
        result = json.loads((path / "evidence" / "result.json").read_text())
    except (OSError, ValueError):
        return None
    return result if isinstance(result, dict) else None


def installer_target(root):
    try:
        state = json.loads((root / "installer.lock").read_text()).get("state")
    except (OSError, ValueError, AttributeError):
        return None
    return Path(state).resolve() if isinstance(state, str) and state else None


def process_start(proc):
    boot = next(int(line.split()[1]) for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime "))
    ticks = int((proc / "stat").read_text().rpartition(")")[2].split()[19])
    return boot + ticks / os.sysconf("SC_CLK_TCK")


def ignored_commands():
    path = Path.home() / ".config/t3nightly/retention-ignore"
    try:
        return {line.strip() for line in path.read_text().splitlines() if line.strip()}
    except FileNotFoundError:
        return set()


def ancestors():
    chain, pid = set(), os.getppid()
    while pid > 1 and pid not in chain:
        chain.add(pid)
        try:
            pid = int(Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return chain


def ignorable(proc, lineage):
    try:
        if int(proc.name) in lineage:
            return True
        command = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
        return bool(command) and command in ignored_commands()
    except OSError:
        return False


def live_references():
    own = os.getpid()
    if sys.platform == "darwin":
        listing = subprocess.run(["ps", "-axww", "-o", "pid=,args="], capture_output=True, text=True, timeout=30, check=True).stdout
        rows = [line.strip().partition(" ") for line in listing.splitlines()]
        references = [args for pid, _, args in rows if pid != str(own)]
        cwds = subprocess.run(["lsof", "-a", "-d", "cwd", "-u", str(os.getuid()), "-Fpn"], capture_output=True, text=True, timeout=60, check=True).stdout
        if not listing.strip() or not cwds.strip():
            raise RuntimeError("process inspection returned nothing")
        pid = None
        for line in cwds.splitlines():
            if line.startswith("p"):
                pid = line[1:]
            elif line.startswith("n") and pid != str(own):
                references.append(line[1:])
        return references, []
    references, protected = [], []
    if not Path("/proc/self/cwd").exists():
        raise RuntimeError("process inspection unavailable")
    lineage = ancestors()
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit() or proc.name == str(own):
            continue
        try:
            mine = proc.stat().st_uid == os.getuid()
            references.append((proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace"))
            references.append(os.readlink(proc / "cwd"))
        except FileNotFoundError:
            continue
        except PermissionError:
            if mine and not ignorable(proc, lineage) and os.lstat(proc / "cwd").st_uid == os.getuid():
                protected.append(process_start(proc))
        except OSError:
            if mine:
                raise
    return references, protected


def held(spellings, references):
    return any(text + "/" in reference or reference.endswith(text) or f"{text} " in reference for text in spellings for reference in references)



def family(path):
    parts = path.name.split("-")
    return parts[1] if len(parts) > 2 and parts[0] == "rehearsal" and parts[1] != "hot" else None


def listed(root, name):
    return sorted(path for path in root.iterdir() if family(path) == name and path.is_dir() and not path.is_symlink())


def target_host(path, result):
    host = (result or {}).get("targetHost")
    if isinstance(host, str) and host:
        return host
    match = FAST_HOST.fullmatch(path.name)
    return match[1] if match else None


def started(path, result):
    try:
        return datetime.fromisoformat(str((result or {}).get("startedAt"))).timestamp()
    except ValueError:
        stat = path.stat()
        return getattr(stat, "st_birthtime", stat.st_mtime)


def pin(path):
    receipt = path / "pin.json"
    if not receipt.exists() and not receipt.is_symlink():
        return None
    try:
        value = json.loads(receipt.read_text())
        return str(value.get("reason") or "pinned") if isinstance(value, dict) else "pinned"
    except (OSError, ValueError):
        return "unreadable pin receipt"


def active(path):
    lock = path / ".rehearsal-active.lock"
    if not lock.is_file():
        return False
    with lock.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
    return False


def due(path, result, own, own_host, own_start):
    if result is not None:
        if result.get("result") in SUCCESS:
            return "passed"
        if own and own_host and target_host(path, result) == own_host and started(path, result) < own_start:
            return "failed before a passing rehearsal for its host"
        return None
    if own and own_host and target_host(path, None) == own_host and started(path, None) < own_start:
        return "unfinished before a passing rehearsal for its host"
    return None


def retain(sandbox_dir, result):
    from .rehearsal_store_gc import home_references, release
    from .rehearsal_storage import store_root

    root = nightly_root()
    sandbox_dir = Path(sandbox_dir).resolve()
    name = family(sandbox_dir)
    if sandbox_dir.parent != root or name is None:
        return {"skipped": "sandbox is outside the nightly root"}
    alias = Path(os.path.abspath(Path.home() / ".t3nightly"))
    own = result.get("result") in SUCCESS
    own_host, own_start = target_host(sandbox_dir, result), started(sandbox_dir, result)
    report = {"approval": APPROVAL, "family": name, "dropped": {}, "pinned": {}, "held": {}, "kept": [], "deleted": [], "bytes": 0}
    with (root / "rehearsal-retention.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        target = installer_target(root)
        references, protected = live_references()
        store, candidates = store_root(), set()
        for path in listed(root, name):
            reason = due(path, result if path == sandbox_dir else finished(path), own, own_host, own_start)
            trees = [tree for tree in (path / "home", path / "evidence/installer-state/rollback-runtime") if tree.is_dir() and not tree.is_symlink() and tree.resolve() == tree and tree.is_relative_to(root)]
            if reason is None or not trees:
                report["kept"].append(path.name)
                continue
            if (pinned := pin(path)) is not None:
                report["pinned"][path.name] = pinned
                continue
            began = started(path, result if path == sandbox_dir else finished(path))
            if target and target.is_relative_to(path):
                report["held"][path.name] = "installer state is inside the sandbox"
            elif protected and max(protected) >= began - 5:
                report["held"][path.name] = "an unreadable process may hold the sandbox"
            elif held({str(path), str(alias / path.name)}, references):
                report["held"][path.name] = "a running process references the sandbox"
            elif path != sandbox_dir and active(path):
                report["held"][path.name] = "rehearsal reservation is held"
            else:
                try:
                    candidates |= home_references(path, store)
                except (OSError, ValueError) as error:
                    report["held"][path.name] = f"store references unreadable: {error}"
                    continue
                for tree in trees:
                    size = kib(tree) * 1024
                    shutil.rmtree(tree)
                    report["deleted"].append({"path": str(tree), "bytes": size})
                    report["bytes"] += size
                report["dropped"][path.name] = reason
    shared = release(candidates)
    report["sharedStore"] = shared
    report["deleted"].extend(shared["deleted"])
    report["bytes"] += shared["bytes"]
    return report
