import fcntl
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PREFIX = "rehearsal-fast-"


def nightly_root():
    return (Path.home() / ".t3nightly").resolve()


def finished(path):
    try:
        result = json.loads((path / "evidence" / "result.json").read_text())
    except (OSError, ValueError):
        return None
    return result if isinstance(result, dict) else None


def rollback_root(path):
    plan = path / "sandbox-plan.json"
    if not plan.is_file():
        return None, "sandbox plan missing"
    try:
        rollback = Path(json.loads(plan.read_text())["rollbackRoot"])
        if rollback.parent != path.parent or rollback.resolve().parent != path.parent or not rollback.name.startswith(PREFIX) or rollback.is_symlink():
            return None, "recorded rollback sandbox escaped the nightly root"
        return rollback, None
    except (OSError, ValueError, KeyError, TypeError) as error:
        return None, f"invalid sandbox plan: {error}"


def legacy_sandbox(path):
    value = {"path": str(path)}
    try:
        stat = path.stat()
        value["ageSeconds"] = max(0, round(datetime.now(timezone.utc).timestamp() - getattr(stat, "st_birthtime", stat.st_mtime)))
        result = subprocess.run(["du", "-sk", str(path)], capture_output=True, text=True, timeout=60, check=False)
        value["sizeBytes"] = int(result.stdout.split()[0]) * 1024
        if result.returncode:
            value["error"] = result.stderr.strip() or f"du exited {result.returncode}"
    except (OSError, ValueError, IndexError, subprocess.SubprocessError) as error:
        value["error"] = str(error)
    return value


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


def rehearsal_start(path):
    try:
        return datetime.fromisoformat(str((finished(path) or {}).get("startedAt"))).timestamp()
    except ValueError:
        return None


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


def listed(root):
    return sorted(path for path in root.iterdir() if path.name.startswith(PREFIX) and path.is_dir() and not path.is_symlink())


def newest_passing(dirs):
    passing = [(str(result.get("finishedAt") or ""), path) for path in dirs if (result := finished(path)) and result.get("result") == "PASS"]
    return max(passing)[1] if passing else None


def run_holds(dirs):
    holds = {}
    now = datetime.now(timezone.utc).timestamp()
    for runs in (nightly_root() / "runs", Path.home() / "t3nightly/runs"):
        for run in sorted(runs.rglob("fast")):
            if not run.is_dir():
                continue
            try:
                if (run / "final-receipt.json").is_file() and now - (run / "timeline.jsonl").stat().st_mtime > 24 * 60 * 60:
                    continue
            except OSError:
                pass
            for plan in sorted(run.glob("sandbox-*.json")):
                try:
                    value = json.loads(plan.read_text())
                    home, rollback = value["home"], value["rollbackRoot"]
                    if not all(isinstance(path, str) and Path(path).is_absolute() for path in (home, rollback)) or Path(home).name != "home":
                        raise ValueError("invalid sandbox paths")
                    names = {Path(home).parent.name, Path(rollback).name}
                    if not all(name.startswith(PREFIX) for name in names):
                        raise ValueError("invalid sandbox root names")
                    reason = f"resumable run: {run}"
                except (OSError, ValueError, KeyError, TypeError) as error:
                    names = {path.name for path in dirs}
                    reason = f"unreadable or malformed run plan {plan}: {error}"
                for name in names:
                    holds.setdefault(name, []).append(reason)
    return holds


def retain(sandbox_dir):
    root = nightly_root()
    sandbox_dir = Path(sandbox_dir).resolve()
    if sandbox_dir.parent != root or not sandbox_dir.name.startswith(PREFIX):
        return {"skipped": "sandbox is outside the nightly root"}
    alias = Path(os.path.abspath(Path.home() / ".t3nightly"))
    with (root / "rehearsal-retention.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        dirs = listed(root)
        holds = run_holds(dirs)
        target = installer_target(root)
        references, protected = live_references()
        report = {"kept": [], "dropped": [], "held": [], "holdReasons": {}, "legacySandboxes": []}
        legacy = [path for path in dirs if not (path / "sandbox-plan.json").is_file()]
        plans = {path: rollback_root(path) for path in dirs}
        newest = newest_passing(dirs)
        keep = {newest, plans[newest][0]} if newest else set()
        for path in dirs:
            home = path / "home"
            _, reason = plans[path]
            if path.name in holds:
                report["held"].append(path.name)
                report["holdReasons"][path.name] = "; ".join(holds[path.name])
                continue
            if reason:
                report["held"].append(path.name)
                report["holdReasons"][path.name] = reason
                continue
            if path in keep:
                report["kept"].append(path.name)
                continue
            removable = [tree for tree in (home, path / "evidence/installer-state/rollback-runtime") if tree.is_dir() and tree.resolve() == tree and tree.is_relative_to(root)]
            if not removable:
                continue
            began = rehearsal_start(path)
            shielded = protected and (began is None or max(protected) >= began - 5)
            if (target and target.is_relative_to(path)) or shielded or held({str(path), str(alias / path.name)}, references):
                report["held"].append(path.name)
            else:
                for tree in removable:
                    shutil.rmtree(tree)
                report["dropped"].append(path.name)
    report["legacySandboxes"] = [legacy_sandbox(path) for path in legacy]
    return report
