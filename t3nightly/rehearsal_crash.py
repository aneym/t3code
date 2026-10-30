import subprocess
import os
import re
import sys
import time

from .install_policy import refuse_probe
from .rehearsal_sandbox import wait_for


def main_pid(label):
    if sys.platform == "darwin":
        result = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"], capture_output=True, text=True, check=True, timeout=15)
        found = re.findall(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
        return found[0] if len(found) == 1 else "0"
    return subprocess.run(["systemctl", "--user", "show", label + ".service", "--property=MainPID", "--value"], capture_output=True, text=True, check=True, timeout=15).stdout.strip()


def launcher_crash(sandbox):
    refuse_probe(sandbox.home, sandbox.port, sandbox.label)
    version = sandbox.version()
    if not version:
        raise ValueError("sandbox launcher crash proof requires a healthy baseline")
    before = sandbox.serving_digest()
    launcher_before = main_pid(sandbox.label)
    connector_before = main_pid(sandbox.label + "-connector")
    command = ["launchctl", "kill", "SIGKILL", f"{sandbox.domain}/{sandbox.label}"] if sys.platform == "darwin" else ["systemctl", "--user", "kill", "--kill-whom=main", "--signal=KILL", f"{sandbox.label}.service"]
    started = time.monotonic()
    subprocess.run(command, capture_output=True, check=True, timeout=15)
    wait_for(lambda: main_pid(sandbox.label) not in ("0", launcher_before) and sandbox.version() == version and sandbox.published(), sandbox.args.health_s, "sandbox launcher crash recovery")
    after = sandbox.serving_digest()
    connector_after = main_pid(sandbox.label + "-connector")
    if connector_before == "0" or connector_before != connector_after:
        raise ValueError("separate connector did not survive launcher crash")
    if after != before:
        raise ValueError("launcher crash changed the serving runtime digest")
    return {"status": "passed", "seconds": round(time.monotonic() - started, 3), "version": version, "digest": after, "launcherBefore": launcher_before, "launcherAfter": main_pid(sandbox.label), "connectorBefore": connector_before, "connectorAfter": connector_after, "listenerDowntimeExcludedFromSwapGuarantee": True}
