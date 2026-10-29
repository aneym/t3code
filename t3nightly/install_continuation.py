import json
import sqlite3
from datetime import datetime, timezone
from contextlib import closing

from .install_prepare import content_hash


def verify_dispositions(run, handoff, captured):
    with closing(sqlite3.connect(f"file:{run.db}?mode=ro", uri=True, timeout=30)) as connection:
        connection.execute("BEGIN")
        threadids = [t["threadId"] for t in handoff["threads"]]
        marks = ",".join("?" for _ in threadids) or "NULL"
        sourceids = [i for t in handoff["threads"] for k in ("runIds", "queuedRunIds") for i in t[k]]
        q = ",".join("?" for _ in sourceids) or "NULL"
        rows = connection.execute(f"select run_id, thread_id, status, payload_json, ordinal from orchestration_v2_projection_runs where run_id in ({q})", sourceids).fetchall()
        floors: dict[str, int] = {}
        for row in rows:
            floors[str(row[1])] = min(floors.get(str(row[1]), int(row[4])), int(row[4]))
        recent = list(rows)
        source_marks = ",".join("?" for _ in sourceids) or "NULL"
        queued_messages = [json.loads(row[3]).get("userMessageId") for row in rows if json.loads(row[3]).get("userMessageId")]
        message_marks = ",".join("?" for _ in queued_messages) or "NULL"
        for thread_id, ordinal in floors.items():
            recent.extend(connection.execute(f"select run_id, thread_id, status, payload_json, ordinal from orchestration_v2_projection_runs where thread_id=? and ordinal>=? and (json_extract(payload_json,'$.restartContinuationOfRunId') in ({source_marks}) or json_extract(payload_json,'$.userMessageId') in ({message_marks}))", [thread_id, ordinal, *sourceids, *queued_messages]).fetchall())
        runs = {row[0]: {"thread_id": row[1], "status": row[2], "payload": json.loads(row[3])} for row in recent}
        reqids = [i for t in handoff["threads"] for i in t["requestIds"]]
        q = ",".join("?" for _ in reqids) or "NULL"
        requestrows = connection.execute(f"select runtime_request_id, status, thread_id, payload_json from orchestration_v2_projection_runtime_requests where runtime_request_id in ({q})", reqids).fetchall()
        for thread_id in threadids:
            requestrows.extend(connection.execute("select runtime_request_id, status, thread_id, payload_json from orchestration_v2_projection_runtime_requests where thread_id=? and status='pending'", (thread_id,)).fetchall())
        requests = {row[0]: {"status": row[1], "thread_id": row[2], "payload": json.loads(row[3])} for row in requestrows}
        nodeids = [i for t in handoff["threads"] for i in t["delegatedTaskIds"]]
        q = ",".join("?" for _ in nodeids) or "NULL"
        nodes = dict(connection.execute(f"select subagent_id, status from orchestration_v2_projection_subagents where subagent_id in ({q})", nodeids).fetchall())
        threads = {row[0]: json.loads(row[1]) for row in connection.execute(f"select thread_id, payload_json from orchestration_v2_projection_threads where thread_id in ({marks})", threadids).fetchall()}
        interrupts = set()
        for thread_id in threadids:
            for run_id in sourceids:
                if connection.execute("select 1 from orchestration_v2_projection_turn_items where thread_id=? and run_id=? and type='run_interrupt_request' limit 1", (thread_id, run_id)).fetchone():
                    interrupts.add(run_id)
        msgids = list({r["user_message_id"] for r in captured if r.get("user_message_id")} | {runs[i]["payload"].get("userMessageId") for i in sourceids if i in runs} - {None})
        q = ",".join("?" for _ in msgids) or "NULL"
        messages = {row[0]: {"run_id": row[1], "thread_id": row[2], "content_sha256": content_hash(row[3])} for row in connection.execute(f"select message_id, run_id, thread_id, payload_json from orchestration_v2_projection_messages where message_id in ({q})", msgids).fetchall()}
        for message in messages.values():
            if message["run_id"] not in runs:
                row = connection.execute("select run_id, thread_id, status, payload_json from orchestration_v2_projection_runs where run_id=?", (message["run_id"],)).fetchone()
                if row:
                    runs[row[0]] = {"thread_id": row[1], "status": row[2], "payload": json.loads(row[3])}
    pending, evidence, stopped = [], [], []
    captured_by_id = {row["run_id"]: row for row in captured}
    for thread in handoff["threads"]:
        for run_id in thread["runIds"]:
            current = runs.get(run_id)
            continued = [key for key, value in runs.items() if value["payload"].get("restartContinuationOfRunId") == run_id]
            if not current or current["thread_id"] != thread["threadId"] or len(continued) > 1:
                raise ValueError("restart lost a source run or created duplicate continuations")
            metadata = threads.get(thread["threadId"], {})
            snoozed = metadata.get("snoozedUntil")
            stop_intent = run_id in interrupts or metadata.get("archivedAt") is not None or metadata.get("deletedAt") is not None or metadata.get("settledOverride") == "settled"
            if snoozed:
                stop_intent = stop_intent or datetime.fromisoformat(snoozed.replace("Z", "+00:00")) > datetime.now(timezone.utc)
            paused_requests = [key for key, value in requests.items() if value["status"] == "pending" and value["thread_id"] == thread["threadId"] and run_id in value["payload"].get("restartContinuationRunIds", [])]
            if stop_intent:
                stopped.append(run_id)
                evidence.append({"source_run_id": run_id, "user_intent_preserved": True})
            elif continued and runs[continued[0]]["status"] in ("queued", "preparing", "starting", "running", "waiting", "completed"):
                if runs[continued[0]]["thread_id"] != thread["threadId"]:
                    raise ValueError("restart continuation moved to another thread")
                evidence.append({"source_run_id": run_id, "continued_run_id": continued[0], "continued_status": runs[continued[0]]["status"], "paused_request_ids": paused_requests})
            elif current["status"] == "completed":
                evidence.append({"source_run_id": run_id, "completed_before_restart": True})
            elif paused_requests:
                evidence.append({"source_run_id": run_id, "paused": True, "paused_request_ids": paused_requests})
            else:
                pending.append(run_id)
        for run_id in thread["queuedRunIds"]:
            current = runs.get(run_id)
            if not current:
                raise ValueError("restart lost a queued run identity")
            original = captured_by_id.get(run_id) or {"user_message_id": current["payload"].get("userMessageId"), "thread_id": current["thread_id"]}
            message_id = original["user_message_id"]
            matches = [key for key, value in runs.items() if value["payload"].get("userMessageId") == message_id and value["thread_id"] == original["thread_id"]]
            if current["payload"].get("userMessageId") != message_id or matches != [run_id]:
                raise ValueError("queued input identity changed or was delivered more than once")
            message = messages.get(message_id)
            if not message or message["thread_id"] != original["thread_id"]:
                raise ValueError("restart lost the queued user message")
            expected_hash = original.get("message_content_sha256")
            if expected_hash and message["content_sha256"] != expected_hash:
                raise ValueError("queued message content changed during restart")
            delivery = runs.get(message["run_id"])
            if not delivery or delivery["status"] in ("failed", "cancelled", "interrupted", "rolled_back"):
                raise ValueError("queued input lacks a surviving delivery run")
            if current["status"] == "cancelled" and message["run_id"] == run_id:
                raise ValueError("queued input was cancelled without batch delivery")
            evidence.append({"queued_run_id": run_id, "delivery_run_id": message["run_id"], "user_message_id": message_id, "preserved": True, "message_content_sha256": message["content_sha256"], "status": delivery["status"]})
        for request_id in thread["requestIds"]:
            if request_id not in requests:
                raise ValueError("restart lost a pending request")
        for node_id in thread["delegatedTaskIds"]:
            if node_id not in nodes:
                raise ValueError("restart lost a delegated task")
    return {"ready": not pending, "pending_run_ids": pending, "stopped_by_user_intent": stopped, "pending_request_ids": [key for key, value in requests.items() if value["status"] == "pending"], "dispositions": evidence}
