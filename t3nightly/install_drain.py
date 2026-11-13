import sqlite3
import time

from .install_land_gate import LandActive, active as land_locks, patterns as land_patterns, wait as land_wait
from .install_protected import ProtectedRunActive, threads, wait
from .live_query import bounded

FINISHING = ("preparing", "starting", "running")
WAITING = ("waiting",)
POLL_S = 1.0
OPEN_RUNS = ("SELECT r.thread_id, r.run_id, r.status, t.title, json_extract(t.payload_json, '$.lineage.rootThreadId') FROM orchestration_v2_projection_runs r "
             "LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id WHERE r.status IN (?,?,?,?) ORDER BY r.thread_id, r.ordinal")


def open_runs(db):
    rows = bounded(db, OPEN_RUNS, (*FINISHING, *WAITING))
    return [{"threadId": thread_id, "runId": run_id, "status": status, "title": title, "rootThreadId": root} for thread_id, run_id, status, title, root in rows]


def refuse(run, error, outcome, active, extra=None):
    run.report["restartDrain"] = {
        **(extra or {}), "outcome": outcome, "drained": False, "waitedMs": round(error.record["waitedSeconds"] * 1000), "deadlineS": run.args.drain_s,
        "activeRunIds": active, "cutRuns": [], "cutRunTitles": [], "waitingRuns": (extra or {}).get("waitingRuns", []),
        "protected" if outcome == "protected-run" else "land": error.record, "stopRefused": True, "retryable": True, "error": str(error),
    }
    run.step("restart-drain", **run.report["restartDrain"])


def hold(run, phase):
    try:
        wait(run, phase)
    except ProtectedRunActive as error:
        refuse(run, error, "protected-run", [row.get("activeRunId") or row["threadId"] for row in error.record["threads"] if row["state"] != "idle"])
        raise
    try:
        land_wait(run, phase)
    except LandActive as error:
        refuse(run, error, "land-running", [])
        raise


def guarded(rows, chosen):
    return [row for row in rows if row["threadId"] in chosen or row.get("rootThreadId") in chosen]


def drain(run):
    deadline_s = run.args.drain_s
    gated = hasattr(run.args, "protected_wait_s")
    chosen = set(threads(run.args)) if gated else set()
    locks_from = land_patterns(run.args) if gated else []
    if gated:
        hold(run, "before-drain")
    protected_left = max(0.0, run.args.protected_wait_s - getattr(run, "protected_waited_s", 0.0)) if gated else 0.0
    land_left = max(0.0, run.args.land_wait_s - getattr(run, "land_waited_s", 0.0)) if gated else 0.0
    started = time.monotonic()
    run.step("restart-drain-start", deadlineS=deadline_s, protectedLeftS=round(protected_left, 3), landLeftS=round(land_left, 3))
    rows, error = [], None
    while True:
        try:
            rows, error = open_runs(run.db), None
        except sqlite3.Error as failure:
            error = str(failure)[:300]
        busy = [row for row in rows if row["status"] in FINISHING]
        held = guarded(busy, chosen)
        locks = land_locks(locks_from) if locks_from else []
        waited = time.monotonic() - started
        over = waited - deadline_s
        if not busy and error is None and not locks:
            break
        if over >= 0 and (not held or over >= protected_left) and (not locks or over >= land_left):
            break
        time.sleep(POLL_S)
    over = max(0.0, waited - deadline_s)
    if gated:
        run.protected_waited_s = getattr(run, "protected_waited_s", 0.0) + (over if held else 0.0)
        run.land_waited_s = getattr(run, "land_waited_s", 0.0) + (over if locks else 0.0)
    drained = not busy and error is None
    result = {
        "outcome": "drained" if drained else "unreadable" if error else "timed-out",
        "drained": drained,
        "waitedMs": round(waited * 1000),
        "deadlineS": deadline_s,
        "extendedS": round(over, 3),
        "activeRunIds": [row["runId"] for row in busy],
        "cutRuns": busy,
        "cutRunTitles": [row.get("title") or row["threadId"] for row in busy],
        "waitingRuns": [row for row in rows if row["status"] in WAITING],
        **({"error": error} if error else {}),
    }
    if held:
        failure = ProtectedRunActive(f"protected run still active at the stop, after the {deadline_s} s drain and {round(protected_left)} s left of --protected-wait-s: "
                                     + ", ".join(f"{row.get('title') or row['threadId']} ({row['runId']})" for row in held) + "; install aborted, nothing stopped")
        failure.record = {"phase": "at-stop", "outcome": "timed-out", "waitedSeconds": waited, "runs": held}
        refuse(run, failure, "protected-run", [row["runId"] for row in busy], result)
        raise failure
    if locks:
        failure = LandActive(f"rails-one land still running at the stop, after the {deadline_s} s drain and {round(land_left)} s left of --land-wait-s: {', '.join(locks)}; install aborted, nothing stopped")
        failure.record = {"phase": "at-stop", "outcome": "timed-out", "waitedSeconds": waited, "held": locks}
        refuse(run, failure, "land-running", [row["runId"] for row in busy], result)
        raise failure
    run.report["restartDrain"] = result
    run.step("restart-drain", **result)
    return result
