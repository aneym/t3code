import hashlib
import json
import shutil
from pathlib import Path


def configure_replay(sandbox):
    root = sandbox.home / "runtime/drain-replay"
    root.mkdir()
    source = sandbox.args.rpc_tree / "apps/server/scripts/dev-replay-agent.ts"
    script = root / "dev-replay-agent.ts"
    shutil.copy2(source, script)
    fixture = root / "dev-replay/showcase_transcript.ndjson"
    fixture.parent.mkdir()
    rows = [{"type": "expect_outbound", "frame": {"kind": "request", "method": "session/prompt", "params": "<any>"}}]
    frame = {"type": "emit_inbound", "afterMs": 2000, "frame": {"kind": "notification", "method": "session/update", "params": {"sessionId": "drain-replay", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Replay drain hold. "}}}}}
    rows.extend(frame for _ in range(60))
    rows.append({"type": "emit_inbound", "frame": {"kind": "response", "method": "session/prompt", "result": {"stopReason": "end_turn"}}})
    fixture.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows))
    node = Path(shutil.which("node")).resolve()
    if str(node).startswith("/Volumes/"):
        raise ValueError("Replay executable must be internal")
    path = sandbox.home / "userdata/settings.json"
    settings = json.loads(path.read_text())
    settings.setdefault("providerInstances", {})["drainReplay"] = {"displayName": "Replay drain proof", "driver": "acpRegistry", "config": {"source": "local", "commandPath": str(node), "commandArgs": [str(script)]}}
    path.write_text(json.dumps(settings, indent=2) + "\n")
    (sandbox.evidence / "replay-source.json").write_text(json.dumps({"source": str(source), "sha256": hashlib.sha256(script.read_bytes()).hexdigest(), "fixture": str(fixture), "frames": 60, "delayMs": 2000, "provider": "drainReplay"}, indent=2) + "\n")

