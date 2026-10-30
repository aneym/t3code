import json
from pathlib import Path

from .rehearsal_sandbox import wait_for


def automatic(workload):
    sandbox = workload.sandbox
    active = workload.work["active-turn"]
    expected = active["expectedOutput"]
    report = {"threadId": active["threadId"], "originalRunId": active["runId"], "expectedOutput": expected, "newUserPromptsSent": 0, "status": "waiting"}
    path = sandbox.evidence / "active-continuation.json"

    def save():
        path.write_text(json.dumps(report, indent=2) + "\n")

    def started():
        rows = sandbox.query("SELECT run_id,status,payload_json FROM orchestration_v2_projection_runs WHERE thread_id=? AND json_extract(payload_json,'$.restartContinuationOfRunId')=? ORDER BY ordinal", (active["threadId"], active["runId"]))
        report["candidates"] = [{"runId": row[0], "status": row[1], "payload": json.loads(row[2])} for row in rows]
        save()
        if len(rows) > 1:
            raise ValueError("multiple direct continuations of the active original run")
        if not rows:
            return None
        run_id, status, raw = rows[0]
        if status in ("failed", "cancelled", "interrupted"):
            raise ValueError("active automatic continuation terminated " + status)
        turns = sandbox.query("SELECT provider_turn_id,status,run_attempt_id FROM orchestration_v2_projection_provider_turns WHERE thread_id=? AND run_attempt_id=json_extract(?,'$.activeAttemptId')", (active["threadId"], raw))
        report["providerTurns"] = turns
        save()
        return {"threadId": active["threadId"], "runId": run_id} if status == "running" and any(turn[1] == "running" for turn in turns) else None

    save()
    continuation = wait_for(started, sandbox.args.chat_timeout, "active thread automatic continuation provider turn on NEW")
    manifest = json.loads(Path(sandbox.args.candidate_manifest).read_text())
    if sandbox.version() != manifest["version"]:
        raise ValueError("automatic continuation is not running on NEW")
    report.update(servingVersion=sandbox.version(), servingDigest=sandbox.serving_digest(), servingChild=json.loads((sandbox.home / "userdata/server-runtime.json").read_text()), continuationRunId=continuation["runId"], originalStatus=sandbox.query("SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?", (active["runId"],))[0][0])
    if report["originalStatus"] not in ("cancelled", "interrupted"):
        raise ValueError("automatic continuation original run was not interrupted")
    user_rows = sandbox.query("SELECT message_id,payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? AND role='user' ORDER BY message_id", (active["threadId"],))
    original_ids = {row[0] for row in workload.before["messages"] if row[1] == active["threadId"] and row[3] == "user"}
    new_rows = [(message_id, json.loads(raw)) for message_id, raw in user_rows if message_id not in original_ids]
    expected_id = "message:restart-continuation:" + active["runId"]
    if len(new_rows) != 1 or new_rows[0][0] != expected_id:
        raise ValueError("active thread received a user prompt other than the automatic restart continuation")
    report["automaticMessage"] = {"messageId": new_rows[0][0], "payload": new_rows[0][1]}
    report["status"] = "running-on-NEW"
    save()
    probe_path = sandbox.evidence / "connection-probe.json"

    def replacement():
        try:
            probe = json.loads(probe_path.read_text())
        except (OSError, ValueError):
            return None
        return next((row for row in probe.get("subscriptions", []) if row.get("sessionId", 0) > 1 and row.get("serverVersion") == manifest["version"] and row.get("afterSequence") is not None), None)

    report["replacementSubscription"] = wait_for(replacement, 30, "NEW replacement subscription before releasing active continuation")
    report["postSwapEventFloor"] = sandbox.query("SELECT coalesce(max(sequence),0) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?", (active["threadId"],))[0][0]
    save()
    (sandbox.home / "release-gate").touch()
    proof = workload.reply(continuation, expected)
    completed = sandbox.query("SELECT status,payload_json FROM orchestration_v2_projection_runs WHERE run_id=? AND thread_id=?", (continuation["runId"], active["threadId"]))
    completed_turns = sandbox.query("SELECT provider_turn_id,status,run_attempt_id FROM orchestration_v2_projection_provider_turns WHERE thread_id=? AND run_attempt_id=json_extract(?,'$.activeAttemptId')", (active["threadId"], completed[0][1]))
    report.update(status="passed", completedStatus=completed[0][0], completedRun=json.loads(completed[0][1]), completedProviderTurns=completed_turns, output=proof, completedServingVersion=sandbox.version())
    if report["completedStatus"] != "completed" or not any(turn[1] == "completed" for turn in completed_turns) or report["completedServingVersion"] != manifest["version"]:
        raise ValueError("automatic active continuation did not complete on NEW")
    final_ids = {row[0] for row in sandbox.query("SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id=? AND role='user'", (active["threadId"],))}
    if final_ids != original_ids | {expected_id}:
        raise ValueError("active continuation completion required another user prompt")
    save()
    return proof, report
