import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


def query(home, sql, parameters=()):
    db = Path(home) / "userdata/statev2.sqlite"
    with closing(sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True, timeout=2)) as connection:
        return connection.execute(sql, parameters).fetchall()


def turn_state(home, turn):
    runs = query(home, "SELECT run_id,status,payload_json FROM orchestration_v2_projection_runs WHERE thread_id=? ORDER BY ordinal", (turn["threadId"],))
    chain = {turn["runId"]}
    candidates = []
    for run_id, status, raw in runs:
        payload = json.loads(raw)
        parent = payload.get("restartContinuationOfRunId")
        if run_id in chain or parent in chain:
            chain.add(run_id)
            candidates.append({"runId": run_id, "status": status, "restartContinuationOfRunId": parent})
    messages = query(home, "SELECT run_id,payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? AND role='assistant' AND streaming=0", (turn["threadId"],))
    completed = [row for row in candidates if row["status"] == "completed" and any(run_id == row["runId"] and json.loads(raw).get("text", "").strip() == turn["nonce"] for run_id, raw in messages)]
    users = query(home, "SELECT message_id,payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? AND role='user'", (turn["threadId"],))
    allowed = {"message:restart-continuation:" + run_id for run_id in chain}
    ordinary = [row[0] for row in users if row[0] not in allowed and not json.loads(row[1]).get("notification")]
    return {"newUserPromptsAfterStart": max(0, len(ordinary) - 1), "runs": candidates, "completedRun": completed[-1] if completed else None, "userMessageIds": [row[0] for row in users]}


def continuity(home, thread, probe):
    snapshots = probe.get("snapshots", [])
    if not snapshots:
        return {"verified": False, "reason": "no initial subscription snapshot", "missedEvents": []}
    floor = snapshots[0]
    expected = [row[0] for row in query(home, "SELECT sequence FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND sequence>? ORDER BY sequence", (thread, floor))]
    observed = set(probe.get("sequences", []))
    missing = [sequence for sequence in expected if sequence not in observed]
    return {"verified": not missing and probe.get("resnapshots", 0) == 0, "afterSequence": floor, "persistedSequences": expected, "receivedSequences": sorted(observed), "missedEvents": missing, "resnapshots": probe.get("resnapshots", 0)}


def receipt(run, job, probe, turn, status, cursor, error=None):
    versions = probe.get("servedVersions", [])
    changed = len(versions) >= 2 and versions[-1]["version"] != versions[0]["version"]
    violations = probe.get("presentationViolations", [])
    new = versions[-1]["version"] if versions else None
    completed = status.get("completedRun")
    continued = bool(completed and completed.get("restartContinuationOfRunId") and turn.get("completedVersion") == new)
    auth = job.get("auth", {})
    cleanup = job.get("unitCleanup", {})
    handoff = []
    for event in probe.get("handoffEvents", []):
        replies = [row for row in probe.get("handoffReplies", []) if row.get("sessionId") == event.get("sessionId") and row.get("sequence") == event.get("sequence") and row.get("confirmation") is False]
        for reply in replies:
            matches = lambda row: row.get("sessionId") == reply.get("sessionId") and row.get("sequence") == reply.get("sequence") and row.get("clientId") == reply.get("clientId")
            acknowledgments = [row for row in probe.get("handoffSettlements", []) if matches(row) and row.get("outcome") == "Success"]
            confirmed = any(matches(row) and row.get("confirmation") is True for row in probe.get("handoffReplies", []))
            if confirmed and any(row.get("confirmation") is False for row in acknowledgments) and any(row.get("confirmation") is True for row in acknowledgments):
                handoff.append({"sessionId": reply["sessionId"], "sequence": reply["sequence"], "clientId": reply["clientId"], "replyResolved": True, "confirmationResolved": True})
    failures = []
    for condition, label in ((probe.get("ready") is True, "client-never-ready"), (not violations, "client-presentation-disconnect"), (cursor.get("verified") is True, "event-continuity-unverified"), (probe.get("refusedConnections", 0) == 0, "refused-connections"), (probe.get("httpFailures", 0) == 0, "failed-http"), (probe.get("wsFailures", 0) == 0, "failed-thread-stream"), (not error, "recorder-error")):
        if not condition:
            failures.append(label)
    if len(versions) > 1 and not changed:
        failures.append("version-reverted-to-original")
    if changed and not handoff:
        failures.append("handoff-event-reply-confirmation-settlement-unproved")
    if not auth.get("revokeVerified"):
        failures.append("session-revoke-unverified")
    if not auth.get("authFileRemoved"):
        failures.append("auth-file-not-removed")
    if not cleanup.get("unitAbsent"):
        failures.append("recorder-unit-cleanup-unverified")
    if job.get("teardownErrors"):
        failures.append("recorder-teardown-errors")
    if status.get("newUserPromptsAfterStart", 0):
        failures.append("unexpected-new-user-prompt")
    if job["turn"] and not completed:
        failures.append("turn-not-completed")
    if changed and job.get("settledAfterSwapSeconds", 0) < 60:
        failures.append("NEW-not-observed-for-60s")
    if changed and not continued:
        failures.append("turn-not-automatically-completed-on-NEW")
    if not job["turn"] and changed:
        failures.append("no-provider-turn-proof")
    grade = "FAIL" if failures else "PASS" if changed else "NO-SWAP-OBSERVED"
    value = {"schema": "t3nightly.live-swap-record/1", "grade": grade, "failures": failures, "host": job["host"], "start": job["start"], "until": job["until"], "finishedAt": datetime.now(timezone.utc).isoformat(), "versionChangeObserved": changed, "settledAfterSwapSeconds": job.get("settledAfterSwapSeconds", 0), "servedVersions": versions, "flipGapMs": probe.get("flipGapMs"), "refusedConnections": probe.get("refusedConnections", 0), "httpFailures": probe.get("httpFailures", 0), "clientDisconnects": len(violations), "missedEvents": cursor.get("missedEvents", []), "continuity": cursor, "probe": probe, "turn": {**turn, **status, "automaticCompletionOnNew": continued}, "error": error, "auth": auth, "unitCleanup": cleanup, "handoffProof": handoff, "teardownErrors": job.get("teardownErrors", []), "observationEndedAt": job.get("observationEndedAt"), "authPath": "installer restart_session: t3 auth session issue/revoke; private 0600 bearer file", "detached": True}
    (run / "receipt.json").write_text(json.dumps(value, indent=2) + "\n")
    md = f"# Live swap recording: {grade}\n\nHost: {job['host']}; versions: " + " → ".join(row["version"] for row in versions) + f"\n\nClient disconnects: {len(violations)}; missed events: {len(value['missedEvents'])}; refused: {value['refusedConnections']}; HTTP failures: {value['httpFailures']}; gap: {value['flipGapMs']} ms.\n\nTurn completed: {bool(completed)}; automatic completion on NEW: {continued}.\n\nFailures: {', '.join(failures) or 'none'}. No swap means NO-SWAP-OBSERVED, never PASS.\n\nAuth: install acceptance CLI-issued session; credential never printed, bearer file 0600, revoke verified: {auth.get('revokeVerified', False)}; bearer removed: {auth.get('authFileRemoved', False)}. Unit absent: {cleanup.get('unitAbsent', False)}.\n\nRaw HTTP/WS/presentation/handoff observations: [probe.json](probe.json). Full cursor and turn proof: [receipt.json](receipt.json). Detached PID/PGID and deadline: [process.json](process.json).\n"
    (run / "receipt.md").write_text(md)
    return value
