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
APPROVAL = str(Path.home() / ".open-factory/approvals/alex-studio-disk-cleanup-2026-10-25.md")
FAST_HOST = re.compile(r"rehearsal-fast-\d+-([a-z0-9]+)-[0-9a-f]{12}(?:-rollback(?:\.[A-Za-z0-9_.-]+)?)?")
SHARED = {"rehearsal-runtimes", "rehearsal-seeds"}
GRACE_S = 30 * 60


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


def holder(spellings, references):
    return next((reference for text in spellings for reference in references if text + "/" in reference or reference.endswith(text) or f"{text} " in reference), None)


def sandboxes(root):
    return sorted(
        path for path in root.iterdir()
        if path.name.startswith("rehearsal-") and not path.name.startswith("rehearsal-hot-swap-") and path.name not in SHARED
        and path.is_dir() and not path.is_symlink() and any((path / part).is_dir() for part in ("evidence", "home", "old-runtime"))
    )


def target_host(path, result):
    host = (result or {}).get("targetHost")
    if isinstance(host, str) and host:
        return host
    match = FAST_HOST.fullmatch(path.name)
    return match[1] if match else None


def moment(result, key):
    try:
        return datetime.fromisoformat(str((result or {}).get(key))).timestamp()
    except ValueError:
        return None


def started(path, result):
    value = moment(result, "startedAt")
    if value is None:
        stat = path.stat()
        value = getattr(stat, "st_birthtime", stat.st_mtime)
    return value


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


def passes(results):
    table = {}
    for path, result in results.items():
        host = target_host(path, result)
        if host and result and result.get("result") in SUCCESS:
            table.setdefault(host, []).append((started(path, result), path.name))
    return table


def due(path, result, table):
    if result and result.get("result") in SUCCESS:
        return "passed", None
    state = "failed" if result else "unfinished"
    host = target_host(path, result)
    if host is None:
        return None, f"{state}; target host unknown"
    later = sorted(item for item in table.get(host, []) if item[0] > started(path, result))
    if later:
        return f"{state}; a later rehearsal for {host} passed: {later[0][1]}", None
    return None, f"{state}; no later passing rehearsal for {host}"


def rollback_proven(path, results):
    try:
        sibling = Path(json.loads((path / "sandbox-plan.json").read_text())["rollbackRoot"])
    except (OSError, ValueError, KeyError, TypeError):
        return False
    result = results.get(sibling) if sibling.parent == path.parent and sibling != path else None
    return bool(result) and result.get("result") == "ROLLBACK-PROOF"


def trees(path, root, results, cited, notes):
    found = [path / "home", path / "evidence/installer-state/rollback-runtime"]
    if (path / "old-runtime").is_dir():
        if rollback_proven(path, results) or path.name not in cited:
            found.append(path / "old-runtime")
        else:
            notes[path.name] = f"old-runtime kept for the rollback proof: {cited[path.name]}"
    return [tree for tree in found if tree.is_dir() and not tree.is_symlink() and tree.resolve() == tree and tree.is_relative_to(root)]


def survey(own=None, own_result=None, *, dry_run=False, cite=None):
    from .rehearsal_store_gc import prune
    from .release_liveness import cited_sandboxes, citing, current_receipts, current_releases, live_runs

    root = nightly_root()
    alias = Path(os.path.abspath(Path.home() / ".t3nightly"))
    report = {"approval": APPROVAL, "dryRun": dry_run, "own": own.name if own else None, "deleted": [], "bytes": 0,
              "dropped": {}, "pinned": {}, "held": {}, "kept": {}, "notes": {}, "empty": []}
    doomed = set()
    current = current_releases(cite)
    receipts = current_receipts(current)
    report["current"] = current
    with (root / "rehearsal-retention.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        target = installer_target(root)
        references, protected = live_references()
        cited = cited_sandboxes(live_runs())
        results = {path: own_result if path == own else finished(path) for path in sandboxes(root)}
        table = passes(results)
        now = datetime.now().timestamp()
        for path, result in results.items():
            reason, keep = due(path, result, table)
            if reason is None:
                report["kept"][path.name] = keep
                continue
            if (pinned := pin(path)) is not None:
                report["pinned"][path.name] = pinned
                continue
            if (receipt := citing(receipts, path)) is not None:
                report["pinned"][path.name] = f"cited by current receipt {receipt}"
                continue
            ended = moment(result, "finishedAt")
            if path != own and ended is not None and now - ended < GRACE_S:
                report["kept"][path.name] = f"{reason}; finished within {GRACE_S // 60} min"
                continue
            removable = trees(path, root, results, cited, report["notes"])
            if not removable:
                report["empty"].append(path.name)
                continue
            if target and target.is_relative_to(path):
                hold = "installer state is inside the sandbox"
            elif protected and max(protected) >= started(path, result) - 5:
                hold = "an unreadable process may hold the sandbox"
            elif (reference := holder({str(path), str(alias / path.name)}, references)) is not None:
                hold = f"a running process references the sandbox: {reference[:160]}"
            elif path != own and active(path):
                hold = "rehearsal reservation is held"
            elif result is None and path.name in cited:
                hold = f"unfinished and cited by a live run: {cited[path.name]}"
            else:
                hold = None
            if hold:
                report["held"][path.name] = hold
                continue
            try:
                for tree in removable:
                    size = kib(tree) * 1024
                    if not dry_run:
                        shutil.rmtree(tree)
                    report["deleted"].append({"path": str(tree), "bytes": size})
                    report["bytes"] += size
            except (OSError, subprocess.SubprocessError) as error:
                report["held"][path.name] = f"deletion stopped: {error}"
                continue
            if path / "home" in removable:
                doomed.add(path)
            report["dropped"][path.name] = reason
    shared = prune(dry_run=dry_run, skip=doomed, keep=lambda entry: citing(receipts, entry))
    report["sharedStore"] = shared
    report["deleted"].extend(shared["deleted"])
    report["bytes"] += shared["bytes"]
    return report


def retain(sandbox_dir, result):
    sandbox_dir = Path(sandbox_dir).resolve()
    if sandbox_dir.parent != nightly_root() or not sandbox_dir.name.startswith("rehearsal-") or sandbox_dir.name.startswith("rehearsal-hot-swap-"):
        return {"skipped": "sandbox is outside the nightly root"}
    return survey(sandbox_dir, result)
