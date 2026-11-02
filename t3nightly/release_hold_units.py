import fcntl
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from .release_jobs import bootout, status, submit, write_status
from .release_timeline import utc_now


def read(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


def unit_active(directory):
    spec = read(Path(directory) / "job.json")
    if not spec:
        return False
    if sys.platform == "darwin":
        command = ["launchctl", "print", f"gui/{os.getuid()}/{spec['label']}"]
    else:
        command = ["systemctl", "--user", "is-active", spec["label"]]
    return subprocess.run(command, capture_output=True, timeout=20, check=False).returncode == 0


def install(config):
    root = Path(config["run"]) / "release-holds"
    root.mkdir(parents=True, exist_ok=True)
    with (root / "control.lock").open("a") as control:
        fcntl.flock(control, fcntl.LOCK_EX)
        previous = read(root / "config.json")
        if previous and previous != config:
            raise ValueError("hold inputs changed; use the original configuration")
        write_status(root / "config.json", config)
        if (root / "watcher.stop").exists():
            raise ValueError("hold watcher was stopped; use a new run directory")
        current = read(root / "unit.json", {"attempt": 0})
        if current.get("directory") and unit_active(current["directory"]):
            return inspect(config)
        if current.get("directory"):
            bootout(current["directory"])
        attempt = current["attempt"] + 1
        directory = root / "units" / str(attempt)
        label = "com.agent-rails.t3fast-hold-" + hashlib.sha256(str(root).encode()).hexdigest()[:16] + f"-{attempt}"
        spec = {"label": label, "host": config["host"], "budget": 365 * 86400,
                "resources": [], "lockRoot": config["lockRoot"],
                "command": [sys.executable, str(Path(__file__).with_name("release-holds")), "worker", str(root)]}
        write_status(root / "unit.json", {"attempt": attempt, "directory": str(directory), "label": label})
        submit(directory, spec)
        return inspect(config)


def inspect(config):
    root = Path(config["run"]) / "release-holds"
    unit = read(root / "unit.json", {})
    return {"host": config["host"], "state": read(root / "state.json", {}), "unit": unit,
            "job": status(unit["directory"]) if unit else {"outcome": "absent"},
            "unitActive": unit_active(unit["directory"]) if unit else False,
            "released": (root / f"{config['host']}.stop").exists(),
            "stopped": (root / "watcher.stop").exists()}


def signal(config, stop=False):
    root = Path(config["run"]) / "release-holds"
    if not (root / "config.json").exists():
        raise ValueError("hold watcher is not installed")
    (root / f"{config['host']}.stop").touch()
    if stop:
        (root / "watcher.stop").touch()
    return inspect(config)


def snapshot(source, host, row):
    root = Path(source["run"]) / "release-holds"
    if host not in source["hosts"]:
        raise ValueError("unknown hold host")
    if row:
        write_status(root / f"{host}.json", row)
        if row.get("ready"):
            (root / f"{host}.ready").touch(exist_ok=True)
    return {"gate": Path(source["gate"]).is_file(),
            "scheduler": read(Path(source["run"]) / "scheduler.json", {}),
            "coordinator": read(Path(source["run"]) / "coordinator/status.json", {})}


def save(root, row, **changes):
    row.update(changes, updated=utc_now())
    write_status(root / "state.json", row)
    return row


def event(root, action, **fields):
    with (root / "events.jsonl").open("a") as handle:
        handle.write(json.dumps({"time": utc_now(), "action": action, **fields}, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def cleanup(config):
    root = Path(config["run"]) / "release-holds"
    current = read(root / "unit.json", {})
    if not current:
        return
    directory = current["directory"]
    if status(directory).get("outcome") in ("passed", "failed", "timed-out"):
        bootout(directory)
        if sys.platform != "darwin":
            subprocess.run(["systemctl", "--user", "reset-failed", current["label"]],
                           capture_output=True, timeout=20, check=False)
