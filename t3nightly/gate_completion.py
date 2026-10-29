import json
import sqlite3
from pathlib import Path


def acknowledged_wake_completion(ctx, name, shown):
    home = Path(ctx.home).resolve()
    if not home.is_relative_to(Path(ctx.work).resolve()):
        return False
    live = (Path.home() / ".t3").resolve()
    if home == live or home.is_relative_to(live):
        return False
    thread_id = shown["thread"]["threadId"]
    replies = [
        message
        for message in shown.get("messages") or []
        if message["role"] == "assistant" and message["text"].strip()
    ]
    if not replies:
        return False
    database = home / "userdata/statev2.sqlite"
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        connection.execute("BEGIN")

        def records(table):
            return [
                json.loads(row[0])
                for row in connection.execute(
                    "SELECT payload_json FROM " + table + " WHERE thread_id = ?",
                    (thread_id,),
                )
            ]

        runs = records("orchestration_v2_projection_runs")
        messages = records("orchestration_v2_projection_messages")
        tasks = records("orchestration_v2_projection_subagents")
        events = [
            (command_id, event_type, json.loads(payload))
            for command_id, event_type, payload in connection.execute(
                "SELECT command_id, event_type, payload_json FROM orchestration_events "
                "WHERE application_event_version = 2 AND stream_id = ? "
                "AND event_type IN ('run.updated', 'subagent.updated')",
                (thread_id,),
            )
        ]
    completed = next((run for run in runs if run["id"] == replies[-1]["runId"]), None)
    if (
        completed is None
        or completed["status"] != "completed"
        or completed.get("startedAt") is None
        or completed.get("completedAt") is None
        or any(
            run["status"] in ("queued", "preparing", "starting", "running", "waiting")
            for run in runs
        )
        or not any(
            kind == "run.updated"
            and event.get("id") == completed["id"]
            and event.get("status") == "completed"
            for _, kind, event in events
        )
    ):
        return False
    newer = [run for run in runs if run["ordinal"] > completed["ordinal"]]
    if (
        not newer
        or max(newer, key=lambda run: run["ordinal"])["id"]
        != shown["thread"]["latestRunId"]
    ):
        return False
    for run in newer:
        if run["status"] != "cancelled" or run.get("startedAt") is not None:
            return False
        message = next(
            (row for row in messages if row["id"] == run["userMessageId"]), {}
        )
        ownership = message.get("delegatedCompletion") or {}
        task_ids = ownership.get("taskIds") or []
        if (
            message.get("creationSource") != "server"
            or message.get("runId") != run["id"]
            or ownership.get("parentRunId") != completed["id"]
            or not isinstance(ownership.get("generation"), int)
            or not 0
            < ownership["generation"]
            < completed.get("delegatedCompletion", {}).get("nextGeneration", 0)
            or not task_ids
        ):
            return False
        cancellation_commands = {
            command
            for command, kind, event in events
            if command is not None
            and kind == "run.updated"
            and event.get("id") == run["id"]
            and event.get("status") == "cancelled"
            and event.get("startedAt") is None
        }
        for task_id in task_ids:
            task = next((row for row in tasks if row["id"] == task_id), {})
            delivery = task.get("completionDelivery") or {}
            if (
                task.get("origin") != "app_owned"
                or task.get("runId") != completed["id"]
                or task.get("status") != "completed"
                or delivery.get("state") != "acknowledged"
                or delivery.get("observedByRunId") != completed["id"]
                or not any(
                    command in cancellation_commands
                    and kind == "subagent.updated"
                    and event.get("id") == task_id
                    and event.get("completionDelivery") == delivery
                    for command, kind, event in events
                )
            ):
                return False
    with open(ctx.log(name), "a") as log:
        log.write(
            "[acknowledged-wake] "
            + json.dumps(
                {
                    "completedRunId": completed["id"],
                    "cancelledUnstartedWakeIds": [run["id"] for run in newer],
                }
            )
            + "\n"
        )
    return True
