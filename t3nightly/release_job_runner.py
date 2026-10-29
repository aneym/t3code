import fcntl
import hashlib
import json
import os
import signal
import subprocess
import time
from contextlib import ExitStack
from pathlib import Path

from .release_jobs import bootout, job_identity, status, write_status
from .release_timeline import utc_now

TERM_GRACE_S = 60


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop_group(process):
    os.killpg(process.pid, signal.SIGTERM)
    deadline = time.monotonic() + TERM_GRACE_S
    while time.monotonic() < deadline:
        process.poll()
        if not group_alive(process.pid):
            break
        time.sleep(0.5)
    if group_alive(process.pid):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    process.wait()


def run(directory):
    directory = Path(directory).resolve()
    spec = json.loads((directory / "job.json").read_text())
    with (directory / "runner.lock").open("a") as owner:
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = status(directory)
        if previous["outcome"] != "submitted":
            bootout(directory)
            return 0
        start = float(previous["monotonicStart"])
        deadline = start + float(spec["budget"])
        evidence = [str(directory / "command.log")]
        row: dict[str, object] = {"identity": job_identity(spec), "outcome": "running", "host": spec["host"],
               "start": utc_now(), "monotonicStart": start, "resourceWaitSeconds": 0,
               "evidence": evidence, "pid": os.getpid()}
        write_status(directory / "status.json", row)
        with ExitStack() as locks, (directory / "command.log").open("a") as log:
            try:
                lock_root = Path(spec["lockRoot"])
                lock_root.mkdir(parents=True, exist_ok=True)
                for resource in sorted(spec["resources"]):
                    name = hashlib.sha256(resource.encode()).hexdigest()
                    handle = locks.enter_context((lock_root / name).open("a"))
                    while True:
                        try:
                            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except BlockingIOError:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0:
                                raise TimeoutError("resource deadline exceeded")
                            time.sleep(min(0.05, remaining))
                row["resourceWaitSeconds"] = time.monotonic() - start
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("stage deadline exceeded")
                process = subprocess.Popen(spec["command"], stdout=log, stderr=subprocess.STDOUT,
                                           cwd=spec.get("cwd", str(directory)), start_new_session=True)
                row["childPid"] = process.pid
                write_status(directory / "status.json", row)
                try:
                    code = process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    stop_group(process)
                    raise TimeoutError("command deadline exceeded") from None
                row["exit"] = code
                outcome = "passed" if code == 0 else "failed"
                if spec.get("result"):
                    result_path = Path(spec["result"])
                    result = json.loads(result_path.read_text())
                    outcome = result["outcome"] if code == 0 else "failed"
                    evidence.append(str(result_path))
                if outcome not in spec.get("outcomes", ["passed", "failed"]):
                    raise ValueError(f"invalid stage outcome: {outcome}")
                if spec.get("install") and not spec.get("result"):
                    raise ValueError("install requires an explicit outcome receipt")
                row["outcome"] = outcome
            except TimeoutError as error:
                row.update(outcome="timed-out", error=str(error))
            except (OSError, ValueError, KeyError, TypeError) as error:
                row.update(outcome="failed", error=str(error))
        finished = time.monotonic()
        row.update(end=utc_now(), monotonicEnd=finished)
        row["seconds"] = finished - start
        write_status(directory / "status.json", row)
        bootout(directory)
        return 0 if row["outcome"] in ("passed", "installed", "current") else 1
