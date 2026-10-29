import os
import plistlib
import re
import subprocess
import sys
from pathlib import Path

from .install_provenance import file_digest
from .install_strays import port_listeners
from .release_signatures import verify_cli


def descends(pid, root, parents):
    seen = set()
    while pid != root:
        if pid in seen or pid not in parents or int(pid) <= 1:
            return False
        seen.add(pid)
        pid = parents[pid]
    return True


def service_binary(run):
    if sys.platform == "darwin":
        with run.service_plist.open("rb") as handle:
            return Path(plistlib.load(handle)["ProgramArguments"][0])
    result = subprocess.run(["systemctl", "--user", "show", run.service_label, "--property=ExecStart", "--value"], capture_output=True, text=True, check=True, timeout=15)
    paths = re.findall(r"path=([^ ;]+)", result.stdout)
    if len(paths) != 1:
        raise ValueError("intended service has no unambiguous ExecStart binary")
    return Path(paths[0])


def serving_process(run, version, expected):
    if sys.platform == "darwin":
        result = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{run.service_label}"], capture_output=True, text=True, check=True, timeout=15)
        roots = re.findall(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
    else:
        result = subprocess.run(["systemctl", "--user", "show", run.service_label, "--property=MainPID", "--value"], capture_output=True, text=True, check=True, timeout=15)
        roots = [result.stdout.strip()]
    listeners = port_listeners(run.args.port)
    if len(roots) != 1 or not roots[0].isdigit() or int(roots[0]) <= 1:
        raise ValueError("intended service has no unambiguous root PID")
    root = roots[0]
    processes = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True, check=True, timeout=15)
    parents = dict(line.split() for line in processes.stdout.splitlines() if len(line.split()) == 2)
    owned = {pid for pid in listeners if descends(pid, root, parents)}
    if len(owned) != 1:
        raise ValueError("endpoint listener does not belong to intended service" if not owned else "intended service has more than one listener PID")
    pid = next(iter(owned))
    allowed = {run.runtime(version).resolve(), service_binary(run).resolve()}
    if sys.platform == "darwin":
        files = subprocess.run(["/usr/sbin/lsof", "-a", "-p", pid, "-d", "txt", "-Fn"], capture_output=True, text=True, check=True, timeout=15)
        executables = {Path(line[1:]).resolve() for line in files.stdout.splitlines() if line.startswith("n")}
        matches = executables & allowed
        if len(matches) != 1:
            raise ValueError("serving executable does not belong to requested runtime")
        executable = next(iter(matches))
    else:
        executable = Path(f"/proc/{pid}/exe").resolve(strict=True)
        if executable not in allowed:
            raise ValueError("serving executable does not belong to requested runtime")
    verify_cli(executable)
    if file_digest(executable) != expected:
        raise ValueError("serving executable digest mismatch")
    run.step("hard-serving", pid=pid, servicePid=root, version=version, digest=expected)
