import json
import os
import shutil
import subprocess
import sys
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


def rollback_name(name):
    prefix, _, host = name.rpartition("-")
    return f"{prefix}-rollback-{host}"


def installer_target(root):
    try:
        state = json.loads((root / "installer.lock").read_text()).get("state")
    except (OSError, ValueError, AttributeError):
        return None
    return Path(state).resolve() if isinstance(state, str) and state else None


def live_references():
    own = os.getpid()
    if sys.platform == "darwin":
        listing = subprocess.run(["ps", "-axww", "-o", "pid=,args="], capture_output=True, text=True, timeout=30, check=False).stdout
        rows = [line.strip().partition(" ") for line in listing.splitlines()]
        references = [args for pid, _, args in rows if pid != str(own)]
        cwds = subprocess.run(["lsof", "-a", "-d", "cwd", "-u", str(os.getuid()), "-Fpn"], capture_output=True, text=True, timeout=60, check=False).stdout
        pid = None
        for line in cwds.splitlines():
            if line.startswith("p"):
                pid = line[1:]
            elif line.startswith("n") and pid != str(own):
                references.append(line[1:])
        return references
    references = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit() or proc.name == str(own):
            continue
        try:
            references.append((proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace"))
            references.append(os.readlink(proc / "cwd"))
        except OSError:
            continue
    return references


def held(path, references):
    text = str(path)
    return any(text + "/" in reference or reference.endswith(text) or f"{text} " in reference for reference in references)


def retain(sandbox_dir):
    root = nightly_root()
    sandbox_dir = Path(sandbox_dir).resolve()
    if sandbox_dir.parent != root or not sandbox_dir.name.startswith(PREFIX):
        return {"skipped": "sandbox is outside the nightly root"}
    dirs = sorted(path for path in root.iterdir() if path.name.startswith(PREFIX) and path.is_dir() and not path.is_symlink())
    passing = [(result.get("finishedAt", ""), path) for path in dirs if (result := finished(path)) and result.get("result") == "PASS"]
    keep = set()
    if passing:
        newest = max(passing)[1]
        keep = {newest, root / rollback_name(newest.name)}
    target = installer_target(root)
    references = live_references()
    report = {"kept": sorted(path.name for path in keep if path.exists()), "dropped": [], "held": []}
    for path in dirs:
        home = path / "home"
        if path in keep or not home.is_dir() or home.is_symlink():
            continue
        if (target and target.is_relative_to(path)) or held(path, references):
            report["held"].append(path.name)
        else:
            shutil.rmtree(home)
            report["dropped"].append(path.name)
    return report
