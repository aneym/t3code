import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

PREFIX = "rehearsal-fast-"
NAME = re.compile(r"rehearsal-fast-(?P<number>[^-]+)-(?P<host>[^-]+)(?:-attempt\d+)?")


def nightly_root():
    return (Path.home() / ".t3nightly").resolve()


def finished(path):
    try:
        result = json.loads((path / "evidence" / "result.json").read_text())
    except (OSError, ValueError):
        return None
    return result if isinstance(result, dict) else None


def rollback_name(name):
    match = NAME.fullmatch(name)
    return f"{PREFIX}{match['number']}-rollback-{match['host']}" if match else None


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
            if mine:
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


def retain(sandbox_dir):
    root = nightly_root()
    sandbox_dir = Path(sandbox_dir).resolve()
    if sandbox_dir.parent != root or not sandbox_dir.name.startswith(PREFIX):
        return {"skipped": "sandbox is outside the nightly root"}
    alias = Path(os.path.abspath(Path.home() / ".t3nightly"))
    with (root / "rehearsal-retention.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        dirs = listed(root)
        target = installer_target(root)
        references, protected = live_references()
        report = {"kept": [], "dropped": [], "held": []}
        for path in dirs:
            home = path / "home"
            newest = newest_passing(listed(root))
            keep = {newest, root / rollback_name(newest.name)} if newest and rollback_name(newest.name) else {newest}
            if path in keep:
                report["kept"].append(path.name)
                continue
            if not home.is_dir() or home.is_symlink():
                continue
            began = rehearsal_start(path)
            shielded = protected and (began is None or max(protected) >= began - 5)
            if (target and target.is_relative_to(path)) or shielded or held({str(path), str(alias / path.name)}, references):
                report["held"].append(path.name)
            else:
                shutil.rmtree(home)
                report["dropped"].append(path.name)
    return report
