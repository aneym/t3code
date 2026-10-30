import json
import os
import re
import subprocess
import sys
from pathlib import Path

from .rehearsal_waiter import identity, now

MIN_FREE_GIB = 65


def disk_gate(evidence=None):
    result = subprocess.run(["df", "-k", "/"], capture_output=True, text=True, check=True, timeout=15)
    free = int(result.stdout.splitlines()[-1].split()[3]) * 1024
    receipt = {"at": now(), "df": result.stdout, "freeGiB": round(free / 1024**3, 3), "minimumGiB": MIN_FREE_GIB}
    if evidence:
        Path(evidence).write_text(json.dumps(receipt, indent=2) + "\n")
    if sys.platform == "darwin" and free < MIN_FREE_GIB * 1024**3:
        raise ValueError(f"Studio rehearsal refused: root has {receipt['freeGiB']} GiB free; requires at least {MIN_FREE_GIB} GiB")
    return receipt


def register(run):
    if os.getpgrp() != os.getpid():
        os.setsid()
    observed = identity(os.getpid())
    if observed is None or observed["pgid"] != os.getpid():
        raise ValueError("rehearsal could not acquire a private process group")
    (run / ".rehearsal-process.json").write_text(json.dumps({"at": now(), "pid": os.getpid(), "pgid": os.getpgrp(), "identity": observed}) + "\n")


def finish(run):
    path = run / ".rehearsal-process.json"
    if path.exists():
        receipt = json.loads(path.read_text())
        if receipt["pid"] != os.getpid():
            raise ValueError("rehearsal process reservation owner changed")
        path.write_text(json.dumps({**receipt, "endedAt": now()}) + "\n")


def running(run):
    path = run / ".rehearsal-process.json"
    if not path.exists():
        if not (run / "evidence/result.json").is_file():
            raise ValueError("rehearsal has no completed result or recorded process group")
        return False
    receipt = json.loads(path.read_text())
    if receipt.get("endedAt"):
        return False
    observed = identity(receipt["pid"])
    return observed == receipt["identity"] and observed["pgid"] == receipt["pgid"]


def remove_databases(home):
    home = Path(home)
    report = {"at": now(), "deleted": [], "bytes": 0}
    if home.is_dir():
        report["homeKiBBefore"] = int(subprocess.run(["du", "-sk", str(home)], capture_output=True, text=True, check=True, timeout=120).stdout.split()[0])
    for directory in (home / "userdata", home / "codex-home", home / "claude-home"):
        if directory.is_symlink():
            raise ValueError("scratch database directory became a symlink")
        for path in directory.rglob("*"):
            if not path.is_file() or path.is_symlink() or not re.search(r"\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$", path.name):
                continue
            if not path.resolve().is_relative_to(home.resolve()) or path.stat().st_uid != os.getuid():
                raise ValueError("scratch database escaped its rehearsal home")
            report["bytes"] += path.stat().st_size
            report["deleted"].append(str(path.relative_to(home)))
            path.unlink()
    if home.is_dir():
        report["homeKiBAfter"] = int(subprocess.run(["du", "-sk", str(home)], capture_output=True, text=True, check=True, timeout=120).stdout.split()[0])
    if home.parent.is_dir():
        (home.parent / "scratch-database-cleanup.json").write_text(json.dumps(report, indent=2) + "\n")
    return report
