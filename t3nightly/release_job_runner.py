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
RESOURCE_WAIT_CAP_S = 3600
HOLD_EXPIRY_S = 86400
LIVE_HOLD_WAIT_S = HOLD_EXPIRY_S + 900


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop_group(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
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


class JobCancelled(Exception):
    pass


def run(directory):
    previous = signal.getsignal(signal.SIGTERM)

    cancelled = False

    def terminate(signum, frame):
        nonlocal cancelled
        cancelled = True

    def check_cancelled():
        if cancelled:
            raise JobCancelled("cancel requested by SIGTERM")

    signal.signal(signal.SIGTERM, terminate)
    try:
        return _run(directory, check_cancelled)
    finally:
        signal.signal(signal.SIGTERM, previous)


def _run(directory, check_cancelled):
    directory = Path(directory).resolve()
    spec = json.loads((directory / "job.json").read_text())
    with (directory / "runner.lock").open("a") as owner:
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = status(directory)
        if previous["outcome"] != "submitted":
            bootout(directory)
            return 0
        start = float(previous["monotonicStart"])
        wait_cap = float(spec.get("resourceWaitCapSeconds", RESOURCE_WAIT_CAP_S))
        wait_deadline = start + wait_cap
        evidence = [str(directory / "command.log")]
        row: dict[str, object] = {"identity": job_identity(spec), "outcome": "running", "host": spec["host"],
               "start": utc_now(), "monotonicStart": start, "resourceWaitSeconds": 0,
               "phase": "waiting-for-resources", "resourceWaitCapSeconds": wait_cap,
               "evidence": evidence, "pid": os.getpid()}
        write_status(directory / "status.json", row)
        with ExitStack() as locks, (directory / "command.log").open("a") as log:
            process = None
            try:
                check_cancelled()
                lock_root = Path(spec["lockRoot"])
                lock_root.mkdir(parents=True, exist_ok=True)
                for resource in sorted(spec["resources"]):
                    row["waitingForResource"] = resource
                    next_status = 0
                    name = hashlib.sha256(resource.encode()).hexdigest()
                    handle = locks.enter_context((lock_root / name).open("a"))
                    while True:
                        check_cancelled()
                        clock = time.monotonic()
                        row["resourceWaitSeconds"] = clock - start
                        remaining = wait_deadline - clock
                        if remaining <= 0:
                            raise TimeoutError(f"resource hold cap exceeded ({wait_cap:g}s) waiting for {resource}")
                        try:
                            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except BlockingIOError:
                            if clock >= next_status:
                                write_status(directory / "status.json", row)
                                next_status = clock + 1
                            time.sleep(min(0.05, remaining))
                work_start = time.monotonic()
                row.update(resourceWaitSeconds=work_start - start, phase="working",
                           waitingForResource=None, workStart=utc_now(), monotonicWorkStart=work_start)
                deadline = work_start + float(spec["budget"])
                process = subprocess.Popen(spec["command"], stdout=log, stderr=subprocess.STDOUT,
                                           cwd=spec.get("cwd", str(directory)), start_new_session=True)
                row["childPid"] = process.pid
                write_status(directory / "status.json", row)
                try:
                    while True:
                        check_cancelled()
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise subprocess.TimeoutExpired(spec["command"], spec["budget"])
                        try:
                            code = process.wait(timeout=min(0.2, remaining))
                            check_cancelled()
                            break
                        except subprocess.TimeoutExpired:
                            if time.monotonic() >= deadline:
                                raise
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
            except JobCancelled as error:
                if process is not None:
                    stop_group(process)
                row.update(outcome="cancelled", reason=str(error))
            except TimeoutError as error:
                row.update(outcome="timed-out", error=str(error))
            except (OSError, ValueError, KeyError, TypeError) as error:
                row.update(outcome="failed", error=str(error))
        finished = time.monotonic()
        row.update(end=utc_now(), monotonicEnd=finished, phase="finished")
        if "monotonicWorkStart" in row:
            row["workSeconds"] = finished - row["monotonicWorkStart"]
        else:
            row["resourceWaitSeconds"] = finished - start
        row["seconds"] = finished - start
        write_status(directory / "status.json", row)
        bootout(directory)
        return 0 if row["outcome"] in ("passed", "installed", "current") else 1
