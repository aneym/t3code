import json
import subprocess
import time

DEFAULT_THREADS = (
    "mcp:launch:069d3ecd4291b4054151ab0bb64617b8f46740268e2896dac9e74579b2844e43",
    "mcp:launch:424b86369f27d72d8ecb4d500172a6daee78c383779ab39ad7bbc6eca94b2158",
)
DEFAULT_WAIT_S = 1800
MAX_WAIT_S = 7200
POLL_S = 10
READ_TIMEOUT_S = 20
BUSY = ("preparing", "starting", "running")
WAITING = ("waiting",)


class ProtectedRunActive(ValueError):
    pass


def threads(args):
    chosen = getattr(args, "protected_thread", None)
    if chosen is None:
        return list(DEFAULT_THREADS)
    return [thread for thread in chosen if thread and thread != "none"]


def read(run, thread):
    binary = run.runtime(run.report["previous"])
    command = [str(binary), "thread", "show", "--base-dir", str(run.home), "--json", "--messages", "0", thread]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=READ_TIMEOUT_S, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"threadId": thread, "state": "unreadable", "error": f"{type(error).__name__}: {error}"[:300]}
    if result.returncode != 0:
        output = f"{result.stdout}\n{result.stderr}"
        if "thread_not_found" in output:
            return {"threadId": thread, "state": "absent"}
        return {"threadId": thread, "state": "unreadable", "error": output.strip()[:300]}
    try:
        data = json.loads(result.stdout)["thread"]
    except (ValueError, KeyError, TypeError) as error:
        return {"threadId": thread, "state": "unreadable", "error": f"thread show output: {error}"[:300]}
    status, active = data.get("status"), data.get("activeRunId")
    busy = status in BUSY or (active is not None and status not in WAITING)
    return {"threadId": thread, "state": "active" if busy else "idle", "status": status, "activeRunId": active}


def wait(run, phase):
    chosen = threads(run.args)
    if not chosen:
        return None
    bound = run.args.protected_wait_s
    spent = getattr(run, "protected_waited_s", 0.0)
    started = time.monotonic()
    while True:
        rows = [read(run, thread) for thread in chosen]
        blocking = [row for row in rows if row["state"] in ("active", "unreadable")]
        waited = spent + time.monotonic() - started
        if not blocking or waited >= bound:
            break
        time.sleep(max(0.0, min(POLL_S, bound - waited)))
    run.protected_waited_s = waited
    record = {"phase": phase, "outcome": "clear" if not blocking else "timed-out", "waitedSeconds": round(waited, 3), "boundSeconds": bound,
              "via": "t3 thread show --json", "threads": rows}
    run.report.setdefault("protectedRuns", []).append(record)
    run.step("protected-run-wait", **record)
    if blocking:
        names = ", ".join(f"{row['threadId']} ({row.get('status') or row['state']})" for row in blocking)
        error = ProtectedRunActive(f"protected thread run still active after the {bound} s --protected-wait-s bound: {names}; install aborted before the drain, nothing stopped")
        error.record = record
        raise error
    return record
