import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

from .live_swap_evidence import receipt
from .rehearsal_waiter import identity


def start_watcher(run, engine):
    with (run / "watcher.log").open("ab") as log:
        process = subprocess.Popen([sys.executable, "-m", "t3nightly.live_swap_cleanup", str(run)], cwd=engine, start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    (run / "watcher-process.json").write_text(json.dumps({"pid": process.pid, "identity": identity(process.pid), "role": "independent-deadline-and-unit-cleanup"}) + "\n")


def request_unload(run, job):
    if not re.fullmatch(r"com\.agent-rails\.t3-live-swap-[a-f0-9]{16}", job["label"]):
        raise ValueError("refused unrecorded recorder unit label")
    (run / "cleanup.request").touch()
    command = ["launchctl", "bootout", f"gui/{os.getuid()}/{job['label']}"] if sys.platform == "darwin" else ["systemctl", "--user", "stop", job["label"] + ".service"]
    subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def unload(run, job):
    label = job["label"]
    if not re.fullmatch(r"com\.agent-rails\.t3-live-swap-[a-f0-9]{16}", label):
        raise ValueError("refused unrecorded live-recorder unit label")
    if sys.platform == "darwin":
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{label}"], capture_output=True, timeout=30)
        command = ["launchctl", "print", f"gui/{os.getuid()}/{label}"]
        deadline = time.monotonic() + 10
        while True:
            result = subprocess.run(command, capture_output=True, text=True, timeout=10)
            absent = result.returncode != 0 and "Could not find service" in result.stderr
            if absent or time.monotonic() >= deadline:
                break
            time.sleep(0.1)
    else:
        subprocess.run(["systemctl", "--user", "stop", label + ".service"], capture_output=True, timeout=30)
        subprocess.run(["systemctl", "--user", "reset-failed", label + ".service"], capture_output=True, timeout=10)
        command = ["systemctl", "--user", "show", label + ".service", "--property=LoadState", "--value"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        absent = result.stdout.strip() == "not-found"
    return {"label": label, "unitAbsent": absent, "command": command, "exit": result.returncode, "stdout": result.stdout if absent else "unit remains loaded", "stderr": result.stderr if absent else ""}


def signal_recorded(run, number):
    paths = [run / "process.json", run / "probe-process.json", *run.glob("gate-*.json")]
    for path in paths:
        try:
            value = json.loads(path.read_text())
            if not isinstance(value, dict):
                continue
            pid = value["pid"]
            if isinstance(pid, int) and pid > 1 and identity(pid) == value["identity"]:
                os.kill(pid, number)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            pass


def main():
    run = Path(sys.argv[1]).resolve()
    job = json.loads((run / "job.json").read_text())
    (run / "watcher.json").write_text(json.dumps({"pid": os.getpid(), "pgid": os.getpgrp(), "identity": identity(os.getpid()), "deadline": job["hardDeadline"]}) + "\n")
    while not (run / "cleanup.request").exists() and not (run / "finished.json").exists() and time.time() < job["hardDeadline"]:
        time.sleep(0.25)
    expired = not (run / "finished.json").exists()
    if expired:
        signal_recorded(run, signal.SIGTERM)
        deadline = time.monotonic() + 75
        while not (run / "finished.json").exists() and time.monotonic() < deadline:
            time.sleep(0.25)
        if not (run / "finished.json").exists():
            signal_recorded(run, signal.SIGKILL)
    try:
        cleanup = unload(run, job)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        cleanup = {"unitAbsent": False, "error": type(error).__name__}
    cleanup.update(deadlineExpired=expired, watcherPid=os.getpid())
    (run / "unit-cleanup.json").write_text(json.dumps(cleanup, indent=2) + "\n")
    inputs = run / "receipt-inputs.json"
    if inputs.exists():
        value = json.loads(inputs.read_text())
        value["job"]["unitCleanup"] = cleanup
        result = receipt(run, **value)
        (run / "finished.json").write_text(json.dumps({"grade": result["grade"], "finishedAt": time.time(), "authFileRemoved": result["auth"]["authFileRemoved"], "revokeVerified": result["auth"]["revokeVerified"], "unitAbsent": cleanup["unitAbsent"], "watcherFinalized": True}) + "\n")
    else:
        (run / "receipt.json").write_text(json.dumps({"grade": "FAIL", "failures": ["worker-did-not-finalize"], "unitCleanup": cleanup}) + "\n")
        (run / "receipt.md").write_text("# Live swap recording: FAIL\n\nWorker did not finalize before the hard deadline. Unit absence: " + str(cleanup["unitAbsent"]) + ". Auth revoke is unverified.\n")
    return 0 if cleanup["unitAbsent"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
