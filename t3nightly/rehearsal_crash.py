import subprocess
import sys
import time

from .install_policy import refuse_probe
from .rehearsal_sandbox import wait_for


def launcher_crash(sandbox):
    refuse_probe(sandbox.home, sandbox.port, sandbox.label)
    version = sandbox.version()
    if not version:
        raise ValueError("sandbox launcher crash proof requires a healthy baseline")
    before = sandbox.serving_digest()
    command = ["launchctl", "kill", "SIGKILL", f"{sandbox.domain}/{sandbox.label}"] if sys.platform == "darwin" else ["systemctl", "--user", "kill", "--kill-whom=main", "--signal=KILL", f"{sandbox.label}.service"]
    started = time.monotonic()
    subprocess.run(command, capture_output=True, check=True, timeout=15)
    wait_for(lambda: sandbox.version() == version and sandbox.published(), sandbox.args.health_s, "sandbox launcher crash recovery")
    after = sandbox.serving_digest()
    if after != before:
        raise ValueError("launcher crash changed the serving runtime digest")
    return {"status": "passed", "seconds": round(time.monotonic() - started, 3), "version": version, "digest": after, "listenerDowntimeExcludedFromSwapGuarantee": True}
