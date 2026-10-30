import json
import sqlite3
import uuid
from datetime import datetime, timezone


def ensure_owners(database, count):
    cursor = database.cursor()
    cursor.row_factory = sqlite3.Row
    templates = list(cursor.execute(
        "select * from orchestration_v2_projection_threads where deleted_at is null "
        "and json_extract(payload_json, '$.archivedAt') is null "
        "and json_extract(payload_json, '$.lineage.parentThreadId') is null order by thread_id"
    ))
    if count and not templates:
        raise RuntimeError("staging needs a stopped sandbox thread to provision automation owners")
    owners = [(row["thread_id"], row["project_id"]) for row in templates]
    for index in range(len(owners), count):
        row = dict(templates[0])
        template = json.loads(row["payload_json"])
        thread_id = "stage-owner-" + uuid.uuid4().hex
        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        title = "Staging automation owner %d" % (index + 1)
        payload = {
            "id": thread_id,
            "projectId": row["project_id"],
            "title": title,
            "createdBy": "system",
            "creationSource": "server",
            "providerInstanceId": template["providerInstanceId"],
            "modelSelection": template["modelSelection"],
            "runtimeMode": template["runtimeMode"],
            "interactionMode": template["interactionMode"],
            "branch": None,
            "worktreePath": None,
            "activeProviderThreadId": None,
            "lineage": {"parentThreadId": None, "relationshipToParent": None, "rootThreadId": thread_id},
            "forkedFrom": None,
            "createdAt": now,
            "updatedAt": now,
            "archivedAt": None,
            "deletedAt": None,
        }
        encoded = json.dumps(payload)
        row.update(thread_id=thread_id, title=title, active_provider_thread_id=None,
                   created_at=now, updated_at=now, archived_at=None, deleted_at=None, payload_json=encoded)
        columns = ",".join(row)
        marks = ",".join("?" for _ in row)
        database.execute("insert into orchestration_v2_projection_threads (%s) values (%s)" % (columns, marks), list(row.values()))
        database.execute(
            "insert into orchestration_events (event_id, aggregate_kind, stream_id, stream_version, "
            "event_type, occurred_at, actor_kind, payload_json, metadata_json) "
            "values (?, 'thread', ?, 1, 'thread.created', ?, 'server', ?, '{}')",
            (str(uuid.uuid4()), thread_id, now, encoded),
        )
        owners.append((thread_id, row["project_id"]))
    return owners
