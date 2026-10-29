def verify_restart_status(status, epoch, handoff, captured, persisted):
    if status.get("epoch") != epoch:
        raise ValueError("restart status belongs to another epoch")
    rows = {row["threadId"]: row for row in status["threads"]}
    originals = {row["run_id"]: row for row in captured}
    persisted_queues = {
        row["queued_run_id"]: row
        for row in persisted["dispositions"]
        if "queued_run_id" in row
    }
    persisted_sources = {
        row["source_run_id"]: row
        for row in persisted["dispositions"]
        if "source_run_id" in row
    }
    pending, dispositions = [], []
    for thread in handoff["threads"]:
        actual = rows.get(thread["threadId"])
        if actual is None:
            covered = set(handoff.get("factoryReconciledSources", [])) | set(
                handoff.get("factoryReconciledQueues", [])
            )
            if (
                not set(thread["runIds"] + thread["queuedRunIds"]) <= covered
                or thread["requestIds"]
                or thread["delegatedTaskIds"]
            ):
                raise ValueError("restart status lost a captured thread")
            actual = {"sources": [], "queues": []}
        sources = {row["sourceRunId"]: row for row in actual["sources"]}
        queues = {row["runId"]: row for row in actual["queues"]}
        for run_id in thread["runIds"]:
            source = sources.get(run_id)
            canonical = persisted_sources.get(run_id, {})
            if source is None:
                if run_id in handoff.get("factoryReconciledSources", []) and (
                    canonical.get("continued_run_id")
                    or canonical.get("completed_before_restart")
                    or canonical.get("user_intent_preserved")
                ):
                    dispositions.append(canonical)
                    continue
                raise ValueError("restart status lost an in-flight source")
            state = source["state"]
            if state == "continued":
                if not source.get("continuationRunId") or source[
                    "continuationRunId"
                ] != canonical.get("continued_run_id"):
                    raise ValueError(
                        "continued source lacks a distinct persisted continuation"
                    )
            elif state == "paused":
                if source.get("reason") != "human_review_required" or not source.get(
                    "requestIds"
                ):
                    raise ValueError(
                        "paused work lacks a persisted human-review request"
                    )
                if not set(source["requestIds"]) <= set(
                    canonical.get("paused_request_ids", [])
                ):
                    raise ValueError(
                        "paused work request IDs are not pending in the database"
                    )
            elif state == "stopped":
                if (
                    source.get("intentPreserved") is not True
                    or run_id not in persisted["stopped_by_user_intent"]
                ):
                    raise ValueError(
                        "restart stopped work without independently verified user intent"
                    )
            elif state == "pending":
                pending.append(run_id)
            elif state == "completed":
                if canonical.get("completed_before_restart") is not True:
                    raise ValueError(
                        "completed source is not completed in the database"
                    )
            else:
                raise ValueError("restart source has an unknown disposition")
            dispositions.append(source)
        for run_id in thread["queuedRunIds"]:
            queued = queues.get(run_id)
            original = originals.get(run_id) or persisted_queues.get(run_id)
            if (
                queued is None
                and run_id in handoff.get("factoryReconciledQueues", [])
                and original is not None
            ):
                dispositions.append(persisted_queues[run_id])
                continue
            if (
                queued is None
                or original is None
                or queued.get("messageId") != original["user_message_id"]
            ):
                raise ValueError("restart status changed queued input identity")
            if queued["state"] in (
                "failed",
                "cancelled",
                "interrupted",
                "rolled_back",
            ) and not queued.get("deliveryRunId"):
                raise ValueError("restart lost queued input delivery")
            if queued["state"] != "queued" and not queued.get("deliveryRunId"):
                raise ValueError("delivered input lacks persisted run ownership")
            dispositions.append(queued)
    return {
        "ready": not pending,
        "pending_run_ids": pending,
        "dispositions": dispositions,
    }
