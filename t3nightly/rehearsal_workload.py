import json
import time
import uuid
from datetime import datetime, timedelta, timezone

from .release_manifest import digest
from .rehearsal_sandbox import wait_for


TERMINAL = ("completed", "failed", "cancelled", "interrupted", "rolled_back")


HOLD_S = 600


class Workload:
    def __init__(self, sandbox):
        self.sandbox = sandbox
        self.work = {}
        self.before = {}
        self.held = None

    def start(self, name, prompt):
        result = self.sandbox.t3("thread", "start", "--provider", self.sandbox.args.provider, "--model", self.sandbox.args.model, "--title", f"rehearsal {name}", str(self.sandbox.project), prompt, "--json")
        self.work[name] = {"threadId": result["threadId"], "runId": result["runId"]}
        return self.work[name]

    def reply(self, item, nonce):
        def completed():
            states = self.sandbox.query("SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?", (item["runId"],))
            if states and states[0][0] in TERMINAL and states[0][0] != "completed":
                raise RuntimeError(f"chat run ended {states[0][0]}")
            rows = self.sandbox.query("SELECT message_id,payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? AND run_id=? AND role='assistant' AND streaming=0", (item["threadId"], item["runId"]))
            exact = [(message, json.loads(payload)) for message, payload in rows if json.loads(payload).get("text", "").strip() == nonce]
            if states == [("completed",)] and len(exact) == 1:
                return {"threadId": item["threadId"], "messageId": exact[0][0], "nonce": nonce, "evidenceDigest": digest(exact[0][1])}
            return None
        return wait_for(completed, self.sandbox.args.chat_timeout, "complete persisted nonce reply")

    def baseline(self):
        nonce = f"REHEARSAL_{uuid.uuid4().hex}"
        item = self.start("stopped-history", f"Reply with exactly {nonce} and nothing else. Do not use tools.")
        proof = self.reply(item, nonce)
        self.sandbox.t3("thread", "settle", item["threadId"], "--json")
        return proof

    def running(self, item):
        states = self.sandbox.query("SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?", (item["runId"],))
        if states and states[0][0] in TERMINAL:
            raise RuntimeError("active rehearsal turn ended before cutover")
        return self.sandbox.query("SELECT t.provider_turn_id FROM orchestration_v2_projection_provider_turns t JOIN orchestration_v2_projection_runs r ON t.thread_id=r.thread_id WHERE r.run_id=? AND r.status='running' AND t.status='running'", (item["runId"],))

    def prepare(self):
        gate = self.sandbox.home / "release-gate"
        prompt = f"Use Bash in the foreground with a {HOLD_S * 1000} ms timeout to run exactly: python3 -c \"import os,time; [time.sleep(1) for _ in iter(lambda: os.path.exists('{gate}'), True)]\"\nDo not background it. Do no other work. After it completes reply RELEASED."
        for name in ("active-turn", "snoozed-thread"):
            if name == "active-turn":
                self.held = time.monotonic()
            item = self.start(name, prompt)
            wait_for(lambda: self.running(item), self.sandbox.args.chat_timeout, "running provider milestone")
        active = self.work["active-turn"]
        nonce = f"QUEUED_{uuid.uuid4().hex}"
        queued = self.sandbox.t3("thread", "send", active["threadId"], f"Reply with exactly {nonce} and nothing else.", "--mode", "queue", "--json")
        self.work["queued-message"] = {"threadId": active["threadId"], "runId": queued["runId"], "messageId": queued.get("messageId"), "nonce": nonce}
        until = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        self.sandbox.t3("thread", "snooze", self.work["snoozed-thread"]["threadId"], "--snoozed-until", until, "--json")
        self.snoozed = self.sandbox.query("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?", (self.work["snoozed-thread"]["threadId"],))[0][0]
        self.before = self.snapshot()
        queued_rows = [row for row in self.before["messages"] if row[2] == queued["runId"] and row[3] == "user"]
        if len(queued_rows) != 1:
            raise ValueError("queued user message was not persisted exactly once")
        if queued.get("messageId") and queued_rows[0][0] != queued["messageId"]:
            raise ValueError("queued CLI and persisted message identities differ")
        self.work["queued-message"]["messageId"] = queued_rows[0][0]
        if not self.running(active):
            raise ValueError("active provider milestone disappeared before cutover")
        return {"work": self.work, "before": self.before}

    def snapshot(self):
        return {
            "threads": self.sandbox.query("SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY thread_id"),
            "messages": self.sandbox.query("SELECT message_id,thread_id,run_id,role,payload_json FROM orchestration_v2_projection_messages ORDER BY message_id"),
        }

    def verify(self):
        if self.held is None or time.monotonic() - self.held > HOLD_S - 10:
            raise RuntimeError("active rehearsal hold may have expired before cutover")
        after = self.snapshot()
        if not set(self.before["threads"]).issubset(set(after["threads"])):
            raise ValueError("historical thread identity lost")
        current = {row[0]: row for row in after["messages"]}
        dispositions = []
        for row in self.before["messages"]:
            if row[0] not in current or current[row[0]][:4] != row[:4]:
                raise ValueError(f"historical message identity lost: {row[0]}")
            if row[3] != "user":
                continue
            if json.loads(current[row[0]][4]).get("text") != json.loads(row[4]).get("text"):
                raise ValueError("prior user message content changed")
            status = self.sandbox.query("SELECT status FROM orchestration_v2_projection_runs WHERE run_id=?", (row[2],)) if row[2] else []
            if row[2] and not status:
                raise ValueError("prior user message run missing")
            dispositions.append({"messageId": row[0], "threadId": row[1], "runId": row[2], "disposition": "persisted-" + (status[0][0] if status else "history")})
        snoozed = self.sandbox.query("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?", (self.work["snoozed-thread"]["threadId"],))[0][0]
        if json.loads(snoozed).get("snoozedUntil") != json.loads(self.snoozed).get("snoozedUntil") or not json.loads(snoozed).get("snoozedUntil"):
            raise ValueError("snoozed state not retained")
        queued = self.work["queued-message"]
        if queued["messageId"] not in current or current[queued["messageId"]][2] != queued["runId"]:
            raise ValueError("queued message identity changed")
        (self.sandbox.home / "release-gate").touch()
        nonce = f"RESUME_{uuid.uuid4().hex}"
        active = self.work["active-turn"]
        result = self.sandbox.t3("thread", "send", active["threadId"], f"Reply with exactly {nonce} and nothing else. Do not use tools.", "--mode", "auto", "--json")
        proof = self.reply({"threadId": active["threadId"], "runId": result["runId"]}, nonce)
        evidence = {"before": self.before, "after": after, "dispositions": dispositions, "queued": queued, "snoozedUntil": json.loads(snoozed)["snoozedUntil"], "resume": proof}
        return proof, evidence
