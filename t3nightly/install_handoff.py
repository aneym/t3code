import json
import sqlite3
import subprocess
import time
from contextlib import closing

RESUMED = ("continued", "completed")
ACTIVE = ("preparing", "starting", "running", "waiting")
STUCK = ("stuck", "missing", "unreported")
ID_FIELDS = ("runIds", "queuedRunIds", "delegatedTaskIds", "pausedRunIds")


def enabled(args):
    return getattr(args, "handoff_stop", None) is True, "window-flag"


def record(receipt, source):
    threads = []
    for handoff in receipt.get("threads") or []:
        ids = {field: list(handoff.get(field) or []) for field in ID_FIELDS}
        if any(ids.values()):
            threads.append({"threadId": handoff["threadId"], **ids})
    return {"epoch": receipt["epoch"], "enabledBy": source, "threads": threads, "preparedThreads": len(receipt.get("threads") or [])}


def admit_stop(run, receipt):
    from .install_policy import isolated

    reported = receipt.get("drain") or {}
    if reported.get("drained") is True:
        return
    active = reported.get("activeRunIds", [])
    outcome = "timed-out" if reported else "unreported"
    drain = run.report.get("restartDrain", {})
    on, source = enabled(run.args)
    run.report["handoffStop"] = {"enabled": on, "enabledBy": source}
    if on and receipt.get("ready") is True and reported.get("drained") is False:
        run.report["restartDrain"] = {**drain, "outcome": outcome, "handoffStop": True, "activeRunIds": active}
        run.report["restartHandoff"] = record(receipt, source)
        handoff = run.report["restartHandoff"]
        run.step("hard-stop-handoff", epoch=handoff["epoch"], enabled_by=source, threads=len(handoff["threads"]), active_run_ids=active)
        return
    args = run.args
    if getattr(args, "rehearsal", False) and not getattr(args, "strict_drain_proof", False) and isolated(run.home, args.port, args.service_label, getattr(args, "live_home", [])):
        run.report["restartDrain"] = {**drain, "outcome": outcome, "stopForcedInRehearsal": True, "activeRunIds": active}
        run.step("rehearsal-stop-after-drain", active_run_ids=active)
        return
    run.report["restartDrain"] = {**drain, "outcome": outcome, "stopRefused": True, "activeRunIds": active, "retryable": True}
    run.step("hard-stop-refused", active_run_ids=active)
    raise ValueError(f"restart drain did not report drained: true; nothing stopped; active_run_ids={active}")


def queue_states(run, handoff):
    rows = []
    with closing(sqlite3.connect(f"{run.db.resolve().as_uri()}?mode=ro", uri=True, timeout=10)) as connection:
        for thread in handoff["threads"]:
            runs = {run_id: (status, json.loads(payload)) for run_id, status, payload in connection.execute("SELECT run_id,status,payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?", (thread["threadId"],))}
            active = sorted(run_id for run_id, (status, _) in runs.items() if status in ACTIVE)
            for run_id in thread.get("queuedRunIds") or []:
                status, payload = runs.get(run_id, ("missing", {}))
                state = status if status != "queued" else "behind-active" if active else "stuck"
                rows.append({"threadId": thread["threadId"], "runId": run_id, "status": status, "state": state, "activeRunIds": active, **({"queueHeld": payload["queueHeld"]} if "queueHeld" in payload else {})})
    return rows


def check_resumed(run, bearer, outcome):
    from .install_rpc import restart_rpc

    handoff = run.report.get("restartHandoff")
    if not handoff or outcome not in ("installed", "current", "rolled-back"):
        return
    expected = {(thread["threadId"], run_id) for thread in handoff["threads"] for run_id in thread["runIds"]}
    wait_s = max(0, getattr(run.args, "handoff_wait_s", 180))
    deadline = time.monotonic() + wait_s
    states, error = {}, None
    while True:
        try:
            status = restart_rpc(run, bearer, "status", {"epoch": handoff["epoch"]}, timeout=60)
            error = None
            states = {(thread["threadId"], source["sourceRunId"]): source for thread in status.get("threads", []) for source in thread.get("sources", [])}
        except (OSError, ValueError, subprocess.SubprocessError) as failure:
            error = str(failure)
        try:
            queues = queue_states(run, handoff)
        except (OSError, ValueError, sqlite3.Error) as failure:
            error = error or str(failure)
            queues = [{"threadId": thread["threadId"], "runId": run_id, "state": "unreported"} for thread in handoff["threads"] for run_id in thread.get("queuedRunIds") or []]
        settled = not error and all(key in states and states[key]["state"] != "pending" for key in expected) and not any(row["state"] in STUCK for row in queues)
        if settled or time.monotonic() >= deadline:
            break
        time.sleep(5)
    runs = []
    for thread_id, run_id in sorted(expected):
        source = states.get((thread_id, run_id), {})
        runs.append({"threadId": thread_id, "runId": run_id, "state": source.get("state", "unreported"), **{key: source[key] for key in ("continuationRunId", "reason") if key in source}})
    handoff["resume"] = {"waitS": wait_s, "checkedAfter": outcome, "runs": runs, "queues": queues, **({"error": error} if error else {})}
    handoff["notResumed"] = [row for row in runs if row["state"] not in RESUMED] + [row for row in queues if row["state"] in STUCK]
    run.step("handoff-resume", epoch=handoff["epoch"], runs=len(runs), queues=len(queues), not_resumed=len(handoff["notResumed"]))
