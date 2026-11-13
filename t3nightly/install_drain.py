import sqlite3
import time

from .live_query import bounded
from .install_protected import ProtectedRunActive, wait

FINISHING = ("preparing", "starting", "running")
WAITING = ("waiting",)
POLL_S = 1.0


def open_runs(db):
    rows = bounded(db, "SELECT thread_id,run_id,status FROM orchestration_v2_projection_runs WHERE status IN (?,?,?,?) ORDER BY thread_id,ordinal", (*FINISHING, *WAITING))
    return [{"threadId": thread_id, "runId": run_id, "status": status} for thread_id, run_id, status in rows]


def hold(run, phase):
    try:
        return wait(run, phase)
    except ProtectedRunActive as error:
        active = [row for row in error.record["threads"] if row["state"] != "idle"]
        run.report["restartDrain"] = {
            "outcome": "protected-run", "drained": False, "waitedMs": round(error.record["waitedSeconds"] * 1000), "deadlineS": run.args.drain_s,
            "activeRunIds": [row.get("activeRunId") or row["threadId"] for row in active], "cutRuns": [], "waitingRuns": [],
            "protected": error.record, "stopRefused": True, "retryable": True, "error": str(error),
        }
        run.step("restart-drain", **run.report["restartDrain"])
        raise


def drain(run):
    deadline_s = run.args.drain_s
    if hasattr(run.args, "protected_wait_s"):
        hold(run, "before-drain")
    started = time.monotonic()
    run.step("restart-drain-start", deadlineS=deadline_s)
    rows, error = [], None
    while True:
        try:
            rows, error = open_runs(run.db), None
        except sqlite3.Error as failure:
            error = str(failure)[:300]
        busy = [row for row in rows if row["status"] in FINISHING]
        waited = time.monotonic() - started
        if (not busy and error is None) or waited >= deadline_s:
            break
        time.sleep(min(POLL_S, deadline_s - waited))
    drained = not busy and error is None
    result = {
        "outcome": "drained" if drained else "unreadable" if error else "timed-out",
        "drained": drained,
        "waitedMs": round(waited * 1000),
        "deadlineS": deadline_s,
        "activeRunIds": [row["runId"] for row in busy],
        "cutRuns": busy,
        "waitingRuns": [row for row in rows if row["status"] in WAITING],
        **({"error": error} if error else {}),
    }
    run.report["restartDrain"] = result
    run.step("restart-drain", **result)
    return result
