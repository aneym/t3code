import json


def client_checks(rehearsal, hot):
    probe = hot.get("probe", {})
    if not probe:
        return
    ids = {row["clientId"] for row in probe.get("handoffCalls", []) if row["method"] == "subscribeServerLifecycle"}
    acknowledgments = [row for row in probe.get("handoffReplies", []) if row.get("sequence") is not None and row["clientId"] in ids and any(event["sequence"] == row["sequence"] and event.get("sessionId") == row.get("sessionId") for event in probe.get("handoffEvents", []))]
    presentation_pass = bool(probe.get("presentations")) and not probe.get("presentationViolations") and bool(ids) and bool(probe.get("handoffEvents"))
    hot["checks"]["presentation"] = {"status": "passed" if presentation_pass else "failed", "states": probe.get("presentations", []), "violations": probe.get("presentationViolations", []), "handoffAcknowledgments": acknowledgments, "acknowledgmentObserved": bool(acknowledgments)}
    continuation_path = rehearsal.sandbox.evidence / "active-continuation.json"
    if continuation_path.is_file():
        continuation = json.loads(continuation_path.read_text())
        active = continuation.get("status") == "passed" and continuation.get("threadId") == rehearsal.probe_thread and continuation.get("originalRunId") == rehearsal.probe_run and continuation.get("completedStatus") == "completed" and continuation.get("completedServingVersion") == rehearsal.version and continuation.get("newUserPromptsSent") == 0
        hot["checks"]["active-automatic-continuation"] = {"status": "passed" if active else "failed", "proof": continuation}
        replacement = continuation.get("replacementSubscription", {})
        floor = continuation.get("postSwapEventFloor")
        received = [row for row in probe.get("receivedEvents", []) if row.get("sessionId") == replacement.get("sessionId") and row.get("serverVersion") == rehearsal.version and isinstance(floor, int) and row["sequence"] > floor]
        successful = [row for row in acknowledgments if any(exit.get("outcome") == "Success" and exit.get("sessionId") == row.get("sessionId") and exit.get("clientId") == row["clientId"] and exit.get("sequence") == row["sequence"] for exit in probe.get("handoffSettlements", []))]
        passed = bool(successful) and bool(received) and presentation_pass and hot.get("sequenceContinuity") is True and probe.get("refusedConnections") == 0
        hot["checks"]["handoff-reply-and-NEW-event"] = {"status": "passed" if passed else "failed", "resolvedRequests": successful, "replacementSubscription": replacement, "postSwapEventFloor": floor, "receivedOnNEW": received}
    keep = probe.get("keepAlive", {})
    if keep.get("reused", 0):
        crossed = [row["id"] for row in keep.get("sockets", []) if hot["oldVersion"] in row["versions"] and rehearsal.version in row["versions"]]
        recovered = any(hot["oldVersion"] in row["versions"] and row["replies"] > 1 for row in keep.get("sockets", [])) and any(rehearsal.version in row["versions"] for row in keep.get("sockets", [])) and len(keep.get("sockets", [])) > 1
        hot["checks"]["keep-alive-freeze"] = {"status": "passed" if crossed or recovered else "failed", "sameSocketsAcrossVersions": crossed, "disposition": "same-socket" if crossed else "closed-or-reset-and-replaced" if recovered else "not-proved", "resetAllowedAtFreeze": True, **keep}
