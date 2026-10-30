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
    if run_key(run):
        from .rehearsal_lifecycle import register

        register(run)
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
    if any(not re.fullmatch(r"(?:com\.)?t3-rehearsal[.-][A-Za-z0-9_.-]+", label) for label in result):
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


def receipt_line(report):
    receipt = Path.home() / ".agent-rails/lanes/t3-hot-swap-cutover/rehearsal-retention.jsonl"
    receipt.parent.mkdir(parents=True, exist_ok=True)
    with receipt.open("a") as output:
        output.write(json.dumps(report, separators=(",", ":")) + "\n")
        output.flush()
        os.fsync(output.fileno())


def homes():
    return sorted((path for path in root().iterdir() if path.is_dir() and not path.is_symlink() and run_key(path) and (path / "home").is_dir()), key=lambda path: (run_key(path), path.name))


def prune_to(limit, run):
    from .rehearsal_lifecycle import running

    report = {"at": datetime.now(timezone.utc).isoformat(), "deleted": [], "kib": 0, "run": run.name, "kept": [], "held": []}
    remaining = homes()
    for path in list(remaining):
        if len(remaining) <= limit:
            break
        with (path / ".rehearsal-active.lock").open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if running(path):
                    raise ValueError("recorded rehearsal process group is still running")
                from .rehearsal_units import unload
                from .rehearsal_waiter import cleanup

                for label in sorted(labels(path), key=lambda value: not value.endswith("-connector")):
                    if loaded(label):
                        unload(path / "home", label)
                    if loaded(label):
                        raise ValueError("sandbox unit remained loaded after recorded-identity teardown")
                cleanup(path / "home", path / "gate-waiters")
                home = path / "home"
                if home.is_symlink() or home.resolve() != home or home.stat().st_uid != os.getuid():
                    raise ValueError("sandbox home identity changed")
                trees = [path / "home", path / "evidence/installer-state/rollback-runtime"]
                trees = [tree for tree in trees if tree.is_dir() and not tree.is_symlink() and tree.resolve().is_relative_to(path.resolve())]
                size = sum(kib(tree) for tree in trees)
                for tree in trees:
                    shutil.rmtree(tree)
                remaining.remove(path)
                report["deleted"].append(str(home))
                report["kib"] += size
                receipt_line({"at": report["at"], "deleted": [str(home)], "kib": size, "run": run.name})
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                report["held"].append({"run": path.name, "reason": str(error)})
    report["kept"] = [path.name for path in remaining]
    return report


def create_home(sandbox):
    from .rehearsal_lifecycle import disk_gate

    run = sandbox.home.parent
    if run.parent != root() or not run_key(run):
        raise ValueError("hot-swap home creation requires its timestamped private run root")
    disk = disk_gate(run / "root-df-before.json")
    with (root() / "hot-swap-retention.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        before = len(homes())
        report = prune_to(1, run)
        after_prune = len(homes())
        if after_prune > 1:
            raise ValueError("rehearsal refused before creating home: older homes are still live or unsafe to prune: " + json.dumps(report["held"]))
        target = run / "rehearsal-target.json"
        staged = target.with_suffix(".next")
        from .rehearsal_units import record

        staged.write_text(json.dumps(record(sandbox)) + "\n")
        os.replace(staged, target)
        sandbox.home.mkdir(mode=0o700)
        receipt = {"at": report["at"], "beforeHomes": before, "afterPruneHomes": after_prune, "afterCreationHomes": len(homes()), "retention": report, "disk": disk}
        (run / "home-creation.json").write_text(json.dumps(receipt, indent=2) + "\n")
        receipt_line({**report, "phase": "before-create", "beforeHomes": before, "afterPruneHomes": after_prune, "afterCreationHomes": receipt["afterCreationHomes"]})
    return receipt


def retain(sandbox_dir):
    run = Path(sandbox_dir).resolve()
    if run.parent != root() or not run_key(run):
        return {"skipped": "outside timestamped hot-swap rehearsal root"}
    with (root() / "hot-swap-retention.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        report = prune_to(2, run)
        receipt_line(report)
    return report
