import os
import re
import subprocess
import sys
from pathlib import Path

from .install_provenance import file_digest
from .release_signatures import verify_cli


def serving_process(run, version, expected):
    if sys.platform == "darwin":
        result = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{run.service_label}"], capture_output=True, text=True, check=True, timeout=15)
        roots = re.findall(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
        sockets = subprocess.run(["/usr/sbin/lsof", "-nP", "-t", f"-iTCP:{run.args.port}", "-sTCP:LISTEN"], capture_output=True, text=True, check=True, timeout=15)
        listeners = set(sockets.stdout.split())
    else:
        result = subprocess.run(["systemctl", "--user", "show", run.service_label, "--property=MainPID", "--value"], capture_output=True, text=True, check=True, timeout=15)
        roots = [result.stdout.strip()]
        sockets = subprocess.run(["ss", "-H", "-ltnp", f"sport = :{run.args.port}"], capture_output=True, text=True, check=True, timeout=15)
        listeners = set(re.findall(r"pid=(\d+),", sockets.stdout))
    if len(roots) != 1 or not roots[0].isdigit() or int(roots[0]) <= 1 or len(listeners) != 1:
        raise ValueError("intended service has no unambiguous root and listener PID")
    root = roots[0]
    pid = next(iter(listeners))
    processes = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True, check=True, timeout=15)
    parents = dict(line.split() for line in processes.stdout.splitlines() if len(line.split()) == 2)
    ancestor = pid
    seen = set()
    while ancestor != root:
        if ancestor in seen or ancestor not in parents or int(ancestor) <= 1:
            raise ValueError("endpoint listener does not belong to intended service")
        seen.add(ancestor)
        ancestor = parents[ancestor]
    allowed = {run.runtime(version).resolve(), (run.home / "runtime/launcher/t3").resolve()}
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
