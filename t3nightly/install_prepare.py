import hashlib
import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone

from .install_copy import backup_database
from .install_feed import persist_release_feed
from .install_runtime import stage_runtime


def content_hash(payload):
    value = json.loads(payload)
    return hashlib.sha256(
        json.dumps(
            {
                key: value.get(key)
                for key in (
                    "text",
                    "attachments",
                    "role",
                    "createdAt",
                    "createdBy",
                    "creationSource",
                )
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def capture_work(run):
    with closing(
        sqlite3.connect(f"file:{run.db}?mode=ro", uri=True, timeout=30)
    ) as connection:
        rows = connection.execute(
            "select run_id, thread_id, status, payload_json, ordinal from orchestration_v2_projection_runs "
            "where status in ('queued','preparing','starting','running','waiting') order by thread_id, ordinal"
        ).fetchall()
        messages = {}
        for row in rows:
            message_id = json.loads(row[3]).get("userMessageId")
            if message_id:
                message = connection.execute(
                    "select payload_json from orchestration_v2_projection_messages where message_id=?",
                    (message_id,),
                ).fetchone()
                if message:
                    messages[message_id] = content_hash(message[0])
    return [
        {
            "run_id": row[0],
            "thread_id": row[1],
            "status": row[2],
            "user_message_id": json.loads(row[3]).get("userMessageId"),
            "payload_sha256": hashlib.sha256(row[3].encode()).hexdigest(),
            "ordinal": row[4],
            "message_content_sha256": messages.get(
                json.loads(row[3]).get("userMessageId")
            ),
        }
        for row in rows
    ]


def prepare(run):
    previous = run.server_version()
    if previous is None:
        raise ValueError("server is not answering; preparation refused")
    stage_runtime(run.home, run.args.version, run.args.assets)
    persist_release_feed(run.args, run.args.version)
    before = capture_work(run)
    backup = backup_database(run, previous, preparing=True)
    after = capture_work(run)
    receipt = {
        "target": run.args.version,
        "previous": previous,
        "backup": str(backup),
        "at": datetime.now(timezone.utc).isoformat(),
        "before": before,
        "after": after,
        "runtime_staged": True,
        "server_restarted": False,
        "handoff_ready": False,
        "remaining": "durable server handoff and continuation proof required before swap",
    }
    path = run.state / "prepared.json"
    path.write_text(json.dumps(receipt, indent=2) + "\n")
    os.chmod(path, 0o600)
    run.step(
        "prepared", receipt=str(path), backup=str(backup), active_or_queued=len(after)
    )
    return 0
