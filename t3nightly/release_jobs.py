import hashlib
import json
import os
import plistlib
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path


TERMINAL = {"passed", "failed", "environment-blocked", "timed-out", "installed", "current", "rolled-back"}


def write_status(path, value):
    path = Path(path)
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    with temporary.open("w") as handle:
        json.dump(value, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def job_identity(spec):
    return hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()


def submit(directory, spec):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    identity = job_identity(spec)
    specification = directory / "job.json"
    try:
        with specification.open("x") as handle:
            json.dump(spec, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        if job_identity(json.loads(specification.read_text())) != identity:
            raise ValueError(f"durable job inputs changed: {directory}")
        value = status(directory)
        if value.get("outcome") in TERMINAL:
            bootout(directory)
        return value
    write_status(directory / "status.json", {"outcome": "submitted", "identity": identity,
                                              "monotonicStart": time.monotonic()})
    label = spec["label"]
    if not re.fullmatch(r"com\.agent-rails\.t3fast-[A-Za-z0-9_.-]+", label):
        raise ValueError("invalid durable job label")
    runner = Path(__file__).resolve().with_name("release-job")
    argv = [sys.executable, str(runner), "run", str(directory)]
    output = str(directory / "launcher.log")
    if sys.platform == "darwin":
        launch_root = Path(tempfile.gettempdir()) / f"t3fast-launchd-{os.getuid()}"
        launch_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        plist = launch_root / f"{label}.plist"
        output = str(launch_root / f"{label}.log")
        with plist.open("wb") as handle:
            plistlib.dump({"Label": label, "ProgramArguments": argv, "RunAtLoad": True,
                          "WorkingDirectory": str(launch_root), "StandardOutPath": output,
                          "StandardErrorPath": output, "ProcessType": "Interactive",
                          "EnvironmentVariables": {"HOME": str(Path.home()), "PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")}}, handle)
        command = ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist)]
    else:
        command = ["systemd-run", "--user", f"--unit={label}", "--collect",
                   "--property=Type=exec", f"--property=WorkingDirectory={directory}",
                   f"--property=StandardOutput=append:{output}",
                   f"--property=StandardError=append:{output}", "--", *argv]
    result = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False)
    if result.returncode:
        raise RuntimeError(f"durable submission unacknowledged; reconnect, do not replay: {result.stderr.strip()}")
    return status(directory)


def bootout(directory):
    directory = Path(directory)
    if sys.platform != "darwin":
        return
    specification = directory / "job.json"
    if not specification.exists():
        return
    label = json.loads(specification.read_text()).get("label")
    if not label:
        return
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{label}"],
                   capture_output=True, text=True, timeout=20, check=False)


def status(directory):
    directory = Path(directory)
    path = directory / "status.json"
    if path.exists():
        return json.loads(path.read_text())
    if (directory / "job.json").exists():
        return {"outcome": "submission-unknown"}
    return {"outcome": "absent"}


class HostJobs:
    def __init__(self, local_run, remote_run, remote_tools, dry_run=False):
        self.local_run = Path(local_run)
        self.remote_run = remote_run
        self.remote_tools = remote_tools
        self.dry_run = dry_run

    def directory(self, node):
        root = str(self.local_run) if node.host == "studio" else self.remote_run
        return f"{root}/jobs/{node.id}"

    def request(self, node, operation, spec=None):
        directory = self.directory(node)
        if self.dry_run:
            if operation == "submit" and spec is not None:
                print(json.dumps({"node": node.id, "host": node.host, "command": spec["command"],
                                  "budget": node.budget, "resources": node.resources}), flush=True)
            clock = time.monotonic()
            return {"outcome": "passed", "resourceWaitSeconds": 0, "evidence": ["dry-run:no-execution"],
                    "monotonicStart": clock, "monotonicEnd": clock, "seconds": 0}
        if node.host == "studio":
            return submit(directory, spec) if operation == "submit" else status(directory)
        argv = [f"{self.remote_tools}/release-job", operation, directory]
        result = subprocess.run(["ssh", "-oBatchMode=yes", "-oConnectTimeout=5", "ax42",
                                 shlex.join(argv)], input=json.dumps(spec) if spec else None,
                                capture_output=True, text=True, timeout=20, check=False)
        if result.returncode:
            if operation == "status":
                return {"outcome": "status-unavailable", "error": result.stderr.strip()}
            raise RuntimeError(f"ax42 {operation} unacknowledged; reconnect without replay: {result.stderr.strip()}")
        return json.loads(result.stdout)
