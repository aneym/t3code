import sqlite3
import time
from contextlib import closing

FINISHING = ("preparing", "starting", "running")
WAITING = ("waiting",)
POLL_S = 1.0


def open_runs(db):
    with closing(sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=10)) as connection:
        rows = connection.execute(
            "SELECT thread_id,run_id,status FROM orchestration_v2_projection_runs WHERE status IN (?,?,?,?) ORDER BY thread_id,ordinal",
            (*FINISHING, *WAITING),
        ).fetchall()
    return [{"threadId": thread_id, "runId": run_id, "status": status} for thread_id, run_id, status in rows]


def drain(run):
    deadline_s = run.args.drain_s
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
