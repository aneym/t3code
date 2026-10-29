import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone


def capture_bridge(run, epoch):
    started = datetime.now(timezone.utc).isoformat()
    with closing(sqlite3.connect(f"file:{run.db}?mode=ro", uri=True, timeout=30)) as connection:
        connection.execute("BEGIN")
        sequence = connection.execute("select coalesce(max(sequence), 0) from orchestration_events where application_event_version=2 and aggregate_kind='thread'").fetchone()[0]
        rows = connection.execute(
            "select run_id, thread_id, status from orchestration_v2_projection_runs "
            "where status in ('queued','preparing','starting','running','waiting')"
        ).fetchall()
        requests = connection.execute(
            "select runtime_request_id, thread_id, payload_json from orchestration_v2_projection_runtime_requests where status='pending'"
        ).fetchall()
        delegated = connection.execute(
            "select subagent_id, thread_id from orchestration_v2_projection_subagents "
            "where status in ('pending','running','waiting')"
        ).fetchall()
        secrets = connection.execute(
            "select thread_id, run_id, payload_json from orchestration_v2_projection_turn_items "
            "where type='secret_request' and status in ('pending','running','waiting')"
        ).fetchall()
    threads = {}
    def thread(thread_id):
        return threads.setdefault(thread_id, {"threadId": thread_id, "runIds": [], "queuedRunIds": [], "requestIds": [], "delegatedTaskIds": [], "paused": False, "pausedRunIds": []})
    for run_id, thread_id, status in rows:
        thread(thread_id)["queuedRunIds" if status == "queued" else "runIds"].append(run_id)
    for request_id, thread_id, payload in requests:
        thread(thread_id)["requestIds"].append(request_id)
        request = json.loads(payload)
        if request.get("kind") not in ("dynamic_tool_call", "auth_refresh") and request.get("responseCapability", {}).get("type") != "message":
            thread(thread_id)["paused"] = True
    for node_id, thread_id in delegated:
        thread(thread_id)["delegatedTaskIds"].append(node_id)
    for thread_id, run_id, payload in secrets:
        if json.loads(payload).get("secretStatus") not in ("saved", "declined"):
            thread(thread_id)["paused"] = True
            if run_id is not None:
                thread(thread_id)["pausedRunIds"].append(run_id)
    return {"epoch": epoch, "startedAt": started, "capturedSequence": sequence, "threads": list(threads.values())}
