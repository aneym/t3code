import hashlib
import json
import shutil
import time
from pathlib import Path

from .rehearsal_sandbox import wait_for
from .rehearsal_workload import Workload


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


def hold_after_rollback(sandbox, stopped):
    evidence = sandbox.evidence / "drain-replay.json"
    deadline = time.monotonic() + sandbox.args.health_s
    try:
        while time.monotonic() < deadline and not stopped.is_set():
            try:
                state = json.loads((sandbox.home / "runtime/service-state.json").read_text())
                update = state.get("update") or {}
                if update.get("status") in ("rolled-back", "failed") and sandbox.version() == sandbox.old.name:
                    turn = sandbox.t3("thread", "start", "--provider", "drainReplay", "--model", "showcase", "--title", "Strict drain Replay proof", str(sandbox.project), "Keep this Replay turn active through the drain deadline.", "--json")
                    run_id = turn["runId"]
                    wait_for(lambda: sandbox.query("SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?", (run_id,)) == [("running",)], 30, "Replay provider running before strict drain")
                    evidence.write_text(json.dumps({"threadId": turn["threadId"], "runId": run_id, "updateId": update["id"], "runningAt": time.time(), "provider": "drainReplay"}, indent=2) + "\n")
                    return
            except (OSError, ValueError, KeyError):
                pass
            stopped.wait(0.1)
        raise ValueError("rollback did not become ready for Replay drain proof")
    except BaseException as error:
        evidence.write_text(json.dumps({"error": type(error).__name__ + ": " + str(error)}, indent=2) + "\n")


def verify_refusal(sandbox, state, baseline, measured):
    replay = json.loads((sandbox.evidence / "drain-replay.json").read_text())
    drain = state.get("restartDrain") or {}
    steps = state["steps"]
    if state.get("outcome") != "failed" or not drain.get("stopRefused") or replay.get("runId") not in drain.get("activeRunIds", []) or drain.get("stopForcedInRehearsal"):
        raise ValueError("strict refusal did not retain the active Replay run")
    if not any(row["step"] == "hard-stop-refused" for row in steps) or any(row["step"] == "hard-service-stop" for row in steps):
        raise ValueError("strict refusal did not prevent service stop")
    trial = state["hotSwap"]["trialRollback"]
    if trial["id"] != replay["updateId"] or trial["status"] not in ("rolled-back", "failed") or sandbox.version() != sandbox.old.name:
        raise ValueError("strict refusal lost verified OLD rollback")
    if sandbox.query("SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?", (replay["runId"],)) != [("running",)]:
        raise ValueError("Replay did not stay active beyond drain deadline")
    chat = Workload(sandbox).baseline()
    abort_failed = any(row["step"] == "fallback-drain-abort-unavailable" for row in steps)
    if bool(drain.get("abortFailed")) != abort_failed:
        raise ValueError("strict drain abort result was recorded incorrectly")
    proof = {"result": "PASS", "releaseEligible": False, "case": "strict-drain-refusal", "baselineChat": baseline, "oldChat": chat, "startupMeasurement": measured, "replay": replay, "rollback": trial, "drain": drain, "steps": steps, "servingVersion": sandbox.version(), "databaseIntegrity": sandbox.query("PRAGMA integrity_check")}
    if proof["databaseIntegrity"] != [("ok",)]:
        raise ValueError("strict refusal database integrity failed")
    path = sandbox.evidence / "strict-drain-proof.json"
    path.write_text(json.dumps(proof, indent=2) + "\n")
    return {"result": "PASS", "releaseEligible": False, "proof": str(path)}
