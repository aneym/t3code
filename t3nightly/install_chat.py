import json
import sqlite3
import subprocess
import tempfile
import time
import uuid
from contextlib import closing
from pathlib import Path

from .live_snapshot import take
from .release_manifest import digest


def query(run, sql, params=()):
    with closing(sqlite3.connect(f"{run.db.resolve().as_uri()}?mode=ro", uri=True, timeout=10)) as connection:
        return connection.execute(sql, params).fetchall()


def identities(run):
    with tempfile.TemporaryDirectory(prefix=".identity-snapshot-", dir=run.home.parent) as raw:
        snapshot = take(Path(raw) / "statev2.sqlite", home=run.home, timeout=getattr(run.args, "snapshot_max_s", 1200))
        with closing(sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True)) as connection:
            return {
                table: {row[0] for row in connection.execute(f"SELECT {key} FROM {table}")}
                for table, key in (("orchestration_v2_projection_threads", "thread_id"), ("orchestration_v2_projection_messages", "message_id"))
            }


def retained(run, before):
    after = identities(run)
    if any(not values.issubset(after[table]) for table, values in before.items()):
        raise ValueError("historical thread or message identities disappeared")


def prove(run, version, baseline=None):
    args = run.args
    provider = baseline["provider"] if baseline else args.chat_provider
    model = baseline["model"] if baseline else args.chat_model
    nonce = "t3-install-" + uuid.uuid4().hex
    command = [str(run.runtime(version)), "thread", "start", "--provider", provider, "--model", model, "--title", "Installer chat proof", str(args.chat_project), f"Reply with exactly {nonce} and nothing else. Do not use tools.", "--json", "--base-dir", str(run.home)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60, check=False)
    if result.returncode:
        raise ValueError("real chat submission failed")
    submitted = json.loads(result.stdout)
    thread, turn = submitted["threadId"], submitted["runId"]
    deadline = time.monotonic() + args.chat_timeout
    while time.monotonic() < deadline:
        rows = query(run, "SELECT message_id, payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? AND run_id=? AND role='assistant' ORDER BY created_at", (thread, turn))
        states = query(run, "SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?", (turn,))
        if states and states[0][0] == "completed":
            matching = [(message, payload) for message, payload in rows if json.loads(payload).get("text", "").strip() == nonce]
            if len(matching) != 1:
                raise ValueError("completed chat did not persist the exact nonce-bound reply")
            message, payload = matching[0]
            proof = {"threadId": thread, "messageId": message, "nonce": nonce, "evidenceDigest": digest({"thread": thread, "run": turn, "message": message, "payload": json.loads(payload)})}
            run.step("hard-chat", version=version, provider=provider, model=model, **proof)
            return {"proof": proof, "provider": provider, "model": model}
        if states and states[0][0] in ("failed", "cancelled", "interrupted", "rolled_back"):
            raise ValueError("real chat turn ended without a completed persisted reply")
        time.sleep(0.5)
    raise TimeoutError("real chat proof deadline exceeded")
