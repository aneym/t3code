import fcntl
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

NAME = re.compile(r"rehearsal-hot-swap-(\d{8}T\d{6}Z)(?:-(?:warm-refusal|fault)(?:-[A-Za-z0-9_.-]+)?)?")


def root():
    return (Path.home() / ".t3nightly").resolve()


def run_key(path):
    match = NAME.fullmatch(path.name)
    return match[1] if match else None


def reserve(sandbox):
    run = sandbox.home.parent
    if run.parent != root() or not (run_key(run) or run.name.startswith("rehearsal-fast-")):
        return None
    run.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = (run / ".rehearsal-active.lock").open("a")
    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return handle


def labels(path):
    result = set()
    identity = path / "rehearsal-target.json"
    if identity.exists():
        target = json.loads(identity.read_text())
        if Path(target["home"]).resolve() != path / "home":
            raise ValueError("rehearsal target home drifted")
        result.add(target["label"].removesuffix(".service"))
    for unit in (path / "home").glob("*.plist"):
        result.add(plistlib.loads(unit.read_bytes())["Label"])
    command = path / "command.json"
    if command.is_file():
        argv = json.loads(command.read_text())
        result.add(argv[argv.index("--label") + 1].removesuffix(".service"))
    if not result or any(not re.fullmatch(r"(?:com\.)?t3-rehearsal[.-][A-Za-z0-9_.-]+", label) for label in result):
        raise ValueError("missing or unsafe sandbox unit identity")
    return result | {label + "-connector" for label in result}


def loaded(label):
    if sys.platform == "darwin":
        result = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"], capture_output=True, text=True, timeout=15)
        if result.returncode == 0:
            return True
        if "Could not find service" not in result.stderr:
            raise ValueError("launchd unit inspection failed")
        return False
    result = subprocess.run(["systemctl", "--user", "show", label + ".service", "--property=LoadState", "--value"], capture_output=True, text=True, timeout=15)
    if result.returncode or result.stdout.strip() not in ("loaded", "not-found"):
        raise ValueError("systemd unit inspection failed")
    return result.stdout.strip() != "not-found"


def kib(path):
    result = subprocess.run(["du", "-sk", str(path)], capture_output=True, text=True, timeout=120, check=True)
    return int(result.stdout.split()[0])


def retain(sandbox_dir):
    parent = root()
    run = Path(sandbox_dir).resolve()
    report = {"at": datetime.now(timezone.utc).isoformat(), "deleted": [], "kib": 0, "run": run.name, "kept": [], "held": []}
    if run.parent != parent or not run_key(run):
        return {**report, "skipped": "outside timestamped hot-swap rehearsal root"}
    receipt = Path.home() / ".agent-rails/lanes/t3-hot-swap-cutover/rehearsal-retention.jsonl"
    receipt.parent.mkdir(parents=True, exist_ok=True)
    with (parent / "hot-swap-retention.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        groups = {}
        for path in parent.iterdir():
            if path.is_dir() and not path.is_symlink() and run_key(path) and (path / "home").is_dir():
                groups.setdefault(run_key(path), []).append(path)
        newest = sorted(groups, reverse=True)[:2]
        for key, paths in sorted(groups.items(), reverse=True):
            if key in newest:
                report["kept"].extend(path.name for path in paths)
                continue
            handles = []
            try:
                for path in paths:
                    handle = (path / ".rehearsal-active.lock").open("a")
                    handles.append(handle)
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    if any(loaded(label) for label in labels(path)):
                        raise ValueError("sandbox unit still loaded")
                    home = path / "home"
                    if home.is_symlink() or home.resolve() != home or home.stat().st_uid != os.getuid():
                        raise ValueError("sandbox home identity changed")
                for path in paths:
                    trees = [path / "home", path / "evidence/installer-state/rollback-runtime"]
                    trees = [tree for tree in trees if tree.is_dir() and not tree.is_symlink() and tree.resolve().is_relative_to(path.resolve())]
                    size = sum(kib(tree) for tree in trees)
                    for tree in trees:
                        shutil.rmtree(tree)
                    report["deleted"].append(str(path / "home"))
                    report["kib"] += size
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                report["held"].append({"runs": [path.name for path in paths], "reason": str(error)})
            finally:
                for handle in handles:
                    handle.close()
        with receipt.open("a") as output:
            output.write(json.dumps(report, separators=(",", ":")) + "\n")
            output.flush()
            os.fsync(output.fileno())
    return report
