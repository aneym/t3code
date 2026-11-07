import fcntl
import hashlib
import os
import plistlib
import subprocess
import sys
import time
from pathlib import Path

from .launch_path import launch_path
from .release_hold_state import read
from .release_jobs import write_status


def unit_active(directory):
    spec = read(Path(directory) / "job.json")
    if not spec:
        return False
    if sys.platform == "darwin":
        result = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{spec['label']}"],
                                capture_output=True, text=True, timeout=20, check=False)
        return result.returncode == 0 and "state = running" in result.stdout
    result = subprocess.run(["systemctl", "--user", "show", "--property=ActiveState", "--value", spec["label"]],
                            capture_output=True, text=True, timeout=20, check=False)
    return result.returncode == 0 and result.stdout.strip() in ("active", "activating", "reloading")


def submit_unit(directory, spec):
    directory.mkdir(parents=True, exist_ok=True)
    write_status(directory / "job.json", spec)
    argv = [sys.executable, "-B", str(Path(__file__).with_name("release-holds")), "worker", spec["root"]]
    output = str(directory / "launcher.log")
    if sys.platform == "darwin":
        plist = directory / "unit.plist"
        with plist.open("wb") as handle:
            plistlib.dump({"Label": spec["label"], "ProgramArguments": argv, "RunAtLoad": True,
                          "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 1, "AbandonProcessGroup": False,
                          "StandardOutPath": output, "StandardErrorPath": output,
                          "EnvironmentVariables": {"HOME": str(Path.home()), "PATH": launch_path("/usr/bin:/bin")}}, handle)
        command = ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist)]
    else:
        linger = subprocess.run(["loginctl", "show-user", str(os.getuid()), "--property=Linger", "--value"],
                                capture_output=True, text=True, timeout=15, check=False)
        if linger.returncode or linger.stdout.strip().lower() != "yes":
            raise RuntimeError("hold watcher requires systemd-user and Linger=yes")
        command = ["systemd-run", "--user", f"--unit={spec['label']}", "--collect",
                   "--property=Type=exec", "--property=Restart=on-failure", "--property=RestartSec=1",
                   "--property=StartLimitIntervalSec=0", "--property=KillMode=control-group", f"--property=StandardOutput=append:{output}",
                   f"--property=StandardError=append:{output}", "--", *argv]
    subprocess.run(command, capture_output=True, text=True, timeout=20, check=True)


def install(config):
    root = Path(config["run"]) / "release-holds"
    root.mkdir(parents=True, exist_ok=True)
    with (root / "control.lock").open("a") as control:
        fcntl.flock(control, fcntl.LOCK_EX)
        previous = read(root / "config.json")
        if previous and previous != config:
            raise ValueError("hold inputs changed; use the original configuration")
        write_status(root / "config.json", config)
        if (root / "watcher.stop").exists() or read(root / "state.json", {}).get("watcher") == "exited":
            raise ValueError("hold watcher has ended; use a new run directory")
        current = read(root / "unit.json", {"attempt": 0})
        if current.get("directory") and unit_active(current["directory"]):
            return inspect_hold(config)
        if not (root / "deadline.json").exists():
            write_status(root / "deadline.json", {"expiresAt": time.time() + config["expirySeconds"]})
        attempt = current["attempt"] + 1
        directory = root / "units" / str(attempt)
        label = "com.agent-rails.t3fast-hold-" + hashlib.sha256(str(root).encode()).hexdigest()[:16] + f"-{attempt}"
        spec = {"label": label, "root": str(root)}
        write_status(root / "unit.json", {"attempt": attempt, "directory": str(directory), "label": label})
        submit_unit(directory, spec)
        return inspect_hold(config)


def inspect_hold(config):
    root = Path(config["run"]) / "release-holds"
    unit = read(root / "unit.json", {})
    row = read(root / "state.json", {})
    return {"host": config["host"], "state": row, "unit": unit,
            "job": {"outcome": row.get("watcher", "submitted")},
            "unitActive": unit_active(unit["directory"]) if unit else False,
            "released": (root / f"{config['host']}.stop").exists(),
            "stopped": (root / "watcher.stop").exists()}


def request_release(config, stop=False):
    root = Path(config["run"]) / "release-holds"
    if not (root / "config.json").exists():
        raise ValueError("hold watcher is not installed")
    (root / f"{config['host']}.stop").touch()
    (root / f"{config['host']}.ready").unlink(missing_ok=True)
    if stop:
        (root / "watcher.stop").touch()
        cleanup(config)
    return inspect_hold(config)


def cleanup(config):
    root = Path(config["run"]) / "release-holds"
    current = read(root / "unit.json", {})
    if current and sys.platform == "darwin" and (read(root / "state.json", {}).get("watcher") == "exited"
                                                or ((root / "watcher.stop").exists() and not unit_active(current["directory"]))):
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{current['label']}"],
                       capture_output=True, timeout=20, check=False)
