import copy

from .install_continuation import verify_dispositions


class ReconcileError(ValueError):
    def __init__(self, message, handoff, persisted):
        super().__init__(message)
        self.handoff = handoff
        self.persisted = persisted


def imported_inventory(status, epoch, captured):
    if status.get("epoch") != epoch:
        raise ValueError("restart status belongs to another epoch")
    captured_queues = {
        (row["thread_id"], row["run_id"])
        for row in captured
        if row["status"] == "queued"
    }
    threads = []
    for row in status.get("threads", []):
        threads.append(
            {
                "threadId": row["threadId"],
                "runIds": [source["sourceRunId"] for source in row.get("sources", [])],
                "queuedRunIds": [
                    queue["runId"]
                    for queue in row.get("queues", [])
                    if (row["threadId"], queue["runId"]) in captured_queues
                ],
                "requestIds": [
                    request_id
                    for source in row.get("sources", [])
                    for request_id in source.get("requestIds", [])
                ],
                "delegatedTaskIds": [],
                "paused": False,
            }
        )
    return {"epoch": epoch, "ready": True, "threads": threads}


def reconcile_import(run, receipt, captured):
    handoff = copy.deepcopy(receipt)
    threads = {row["threadId"]: row for row in handoff["threads"]}
    present = {
        key
        for row in threads.values()
        for kind in ("runIds", "queuedRunIds")
        for key in row[kind]
    }
    omitted_sources, omitted_queues = [], []
    for row in captured:
        if row["run_id"] in present:
            continue
        thread = threads.setdefault(
            row["thread_id"],
            {
                "threadId": row["thread_id"],
                "runIds": [],
                "queuedRunIds": [],
                "requestIds": [],
                "delegatedTaskIds": [],
                "paused": False,
            },
        )
        queued = row["status"] == "queued"
        thread["queuedRunIds" if queued else "runIds"].append(row["run_id"])
        (omitted_queues if queued else omitted_sources).append(row["run_id"])
    handoff["threads"] = list(threads.values())
    handoff["factoryReconciledSources"] = omitted_sources
    handoff["factoryReconciledQueues"] = omitted_queues
    try:
        canonical = verify_dispositions(run, handoff, captured)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ReconcileError(
            f"canonical restart verification failed: {error}; "
            f"omitted sources={omitted_sources}, queues={omitted_queues}",
            handoff,
            {"error": str(error)},
        ) from error
    sources = {
        row["source_run_id"]: row
        for row in canonical["dispositions"]
        if "source_run_id" in row
    }
    queues = {
        row["queued_run_id"]: row
        for row in canonical["dispositions"]
        if "queued_run_id" in row
    }
    for run_id in omitted_sources:
        source = sources.get(run_id, {})
        if not (
            source.get("continued_run_id")
            or source.get("completed_before_restart")
            or source.get("user_intent_preserved")
        ):
            raise ReconcileError(
                f"import omitted work without a canonical preserved disposition: {run_id}",
                handoff,
                canonical,
            )
    for run_id in omitted_queues:
        if queues.get(run_id, {}).get("status") not in (
            "queued",
            "completed",
            "running",
            "waiting",
            "starting",
            "preparing",
        ):
            raise ReconcileError(
                f"import omitted an undelivered queued input: {run_id}",
                handoff,
                canonical,
            )
    return handoff
