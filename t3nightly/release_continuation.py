import json
from datetime import datetime
from pathlib import Path


def require_studio_proof(config):
    path = config.verdict.parent / "studio-continuation-proof.json"
    proof = json.loads(path.read_text())
    head = json.loads((config.run / "assembly.json").read_text())["head"]
    if proof.get("target") != config.version or proof.get("head") != head:
        raise ValueError("Studio continuation proof does not match the candidate")
    if proof.get("host") != "studio" or proof.get("server_version") != config.version:
        raise ValueError("Studio continuation proof has no matching running server")
    if proof.get("approved") is not True:
        raise ValueError("lead has not approved the real Studio continuation proof")
    restart = proof["restart"]
    if not all(isinstance(restart.get(key), int) and restart[key] > 0 for key in ("old_pid", "new_pid")):
        raise ValueError("Studio proof requires actual runtime PIDs")
    if restart["old_pid"] == restart["new_pid"]:
        raise ValueError("Studio proof did not restart the runtime")
    if datetime.fromisoformat(restart["before_at"]) >= datetime.fromisoformat(restart["after_at"]):
        raise ValueError("Studio restart timestamps are not ordered")
    active, queued = proof["active"], proof["queued"]
    if not active or not queued:
        raise ValueError("Studio mid-turn proof must include active work and queued input")
    identities = []
    for row in active:
        source = row["source_run_id"]
        evidence = json.loads(Path(row["evidence"]).read_text())
        if row.get("status") == "paused":
            if evidence.get("source_run_id") != source or evidence.get("paused") is not True:
                raise ValueError("Studio pending-human work lacks durable paused evidence")
            identities.append(source)
            continue
        continuation = row["continued_run_id"]
        if not source or not continuation or source == continuation:
            raise ValueError("Studio active work lacks a distinct continuation")
        if evidence.get("source_run_id") != source or evidence.get("continued_run_id") != continuation:
            raise ValueError("Studio active evidence does not match persisted continuation IDs")
        identities.append(source)
    if len(identities) != len(set(identities)):
        raise ValueError("Studio proof repeats an active run")
    identities = []
    for row in queued:
        message = row["user_message_id"]
        evidence = json.loads(Path(row["evidence"]).read_text())
        if not message or evidence.get("user_message_id") != message:
            raise ValueError("Studio queued evidence does not match the persisted input")
        if row.get("status") == "paused":
            if evidence.get("paused") is not True or evidence.get("delivery_count") != 0:
                raise ValueError("Studio pending-human input did not remain durably paused")
        elif row.get("delivery_count") != 1 or evidence.get("delivery_count") != 1:
            raise ValueError("Studio queued input lacks exactly-once delivery evidence")
        identities.append(message)
    if len(identities) != len(set(identities)):
        raise ValueError("Studio proof repeats queued input")
    return path
