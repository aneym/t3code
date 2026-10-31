import json
import os
import secrets
import time
import urllib.error
import urllib.request

from .gate_checks import CLAUDE_MODEL, t3
from .gate_completion import acknowledged_wake_completion
from .gate_proc import CheckFailed

TOOL_BYTES_MAX = int(os.environ.get("T3NIGHTLY_MCP_TOOL_BYTES_MAX", "48000"))
CAPABILITY_MODELS_MAX = int(os.environ.get("T3NIGHTLY_CAPABILITY_MODELS_MAX", "40"))
MERGED_TOOLS = ("t3_queue", "t3_pending_request", "t3_thread_transfer")


class Mcp:
    def __init__(self, ctx, name, deadline):
        self.origin = ctx.origin.rstrip("/")
        self.deadline = deadline
        issued = ctx.work / ("%s.session" % name)
        code, _ = t3(
            ctx,
            name,
            deadline,
            "auth session issue",
            "--scope",
            "orchestration:read",
            "--scope",
            "orchestration:operate",
            "--subject",
            "mcp-client",
            "--ttl",
            "10m",
            "--label",
            "t3nightly-%s" % name,
            "--json",
            cap=60,
            secret_out=str(issued),
        )
        if code != 0:
            raise CheckFailed("t3 auth session issue exited %d" % code)
        self.token = json.loads(issued.read_text())["token"]
        issued.unlink()
        self.session = None
        self.rpc = 0
        reply = self.post(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "t3nightly-gate", "version": "1"},
            },
        )
        if "result" not in reply:
            raise CheckFailed("MCP initialize failed: %s" % str(reply)[:200])
        self.post("notifications/initialized", None)

    def post(self, method, params):
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            self.rpc += 1
            payload.update(id=self.rpc, params=params)
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": "Bearer %s" % self.token,
            "MCP-Protocol-Version": "2025-06-18",
        }
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        request = urllib.request.Request(
            "%s/mcp" % self.origin,
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=self.deadline.left(60)
            ) as response:
                self.session = response.headers.get("Mcp-Session-Id") or self.session
                raw = response.read().decode("utf-8", "replace").strip()
        except urllib.error.HTTPError as error:
            raise CheckFailed(
                "MCP %s answered HTTP %d" % (method, error.code)
            ) from error
        if not raw:
            return {}
        if raw.startswith("{"):
            return json.loads(raw)
        data = [
            line[5:].strip() for line in raw.splitlines() if line.startswith("data:")
        ]
        return json.loads(data[-1]) if data else {}

    def call(self, name, arguments):
        reply = self.post("tools/call", {"name": name, "arguments": arguments})
        result = reply.get("result") or {}
        if "error" in reply or result.get("isError"):
            raise CheckFailed(
                "%s failed: %s" % (name, str(reply.get("error") or result)[:300])
            )
        data = result.get("structuredContent")
        if data is None:
            text = "".join(item.get("text", "") for item in result.get("content") or [])
            data = json.loads(text) if text.strip().startswith(("{", "[")) else text
        return data


def model_visible_bytes(tools):
    seen = [
        {
            "name": tool["name"],
            "description": tool.get("description"),
            "inputSchema": tool.get("inputSchema"),
        }
        for tool in tools
    ]
    return len(json.dumps(seen, separators=(",", ":"), ensure_ascii=False).encode())


def mcp_tools(ctx, deadline):
    mcp = Mcp(ctx, "mcp-tools", deadline)
    tools = mcp.post("tools/list", {}).get("result", {}).get("tools") or []
    names = {tool["name"] for tool in tools}
    size = model_visible_bytes(tools)
    missing = [name for name in MERGED_TOOLS if name not in names]
    if missing:
        raise CheckFailed("merged action tools missing: %s" % ", ".join(missing))
    if size > TOOL_BYTES_MAX:
        raise CheckFailed(
            "tool list is %d bytes, over the %d budget" % (size, TOOL_BYTES_MAX)
        )
    capabilities = mcp.call("orchestrator_capabilities", {})
    models = sum(
        len(provider.get("models") or [])
        for provider in capabilities.get("providers") or []
    )
    if models > CAPABILITY_MODELS_MAX:
        raise CheckFailed("orchestrator_capabilities lists %d models" % models)
    return (
        "%d tools, %d model-visible bytes (budget %d); orchestrator_capabilities lists %d models"
        % (
            len(tools),
            size,
            TOOL_BYTES_MAX,
            models,
        )
    )


def wait_for(ctx, name, deadline, thread_id, done, reserve=20):
    while True:
        code, out = t3(ctx, name, deadline, "thread show", "--json", thread_id, cap=60)
        shown = json.loads(out) if code == 0 and out.strip().startswith("{") else {}
        thread = shown.get("thread") or {}
        if (
            thread.get("activeRunId") is None
            and done(shown)
            and (
                thread.get("status") == "completed"
                or (
                    thread.get("status") == "cancelled"
                    and acknowledged_wake_completion(ctx, name, shown)
                )
            )
        ):
            return shown
        if deadline.left() < reserve:
            raise CheckFailed(
                "thread %s still %s; last reply %r"
                % (thread_id, thread.get("status"), last_reply(shown)[:120])
            )
        time.sleep(5)


def last_reply(shown):
    replies = [
        m["text"]
        for m in shown.get("messages") or []
        if m["role"] == "assistant" and m["text"].strip()
    ]
    return replies[-1] if replies else ""


def first_line(text):
    lines = text.strip().splitlines()
    return lines[0].strip() if lines else ""


def agent_tools(ctx, deadline):
    name = "agent-tools"
    fruit = "%s-%d" % (
        secrets.choice(["kiwi", "mango", "plum", "pear", "fig"]),
        1000 + secrets.randbelow(9000),
    )
    (ctx.project / "fruit.txt").write_text(fruit + "\n")
    prompt = (
        "Use T3's tools. 1) Call delegate_task with provider claudeAgent, model %s, and this task: "
        "'Read the file fruit.txt and reply with only its contents.' "
        "2) Wait for that child with t3_background_wait or task_status until it is done. "
        "Do not read fruit.txt yourself. 3) Reply with only the child's reply."
        % CLAUDE_MODEL
    )
    code, out = t3(
        ctx,
        name,
        deadline,
        "thread start",
        "--provider",
        "claudeAgent",
        "--model",
        CLAUDE_MODEL,
        "--json",
        str(ctx.project),
        prompt,
        cap=60,
    )
    if code != 0:
        raise CheckFailed("t3 thread start exited %d" % code)
    parent = json.loads(out)["threadId"]
    shown = wait_for(
        ctx,
        name,
        deadline,
        parent,
        lambda view: fruit == first_line(last_reply(view)),
        reserve=150,
    )
    mcp = Mcp(ctx, name, deadline)
    project = shown["thread"]["projectId"]
    listed = mcp.call(
        "t3_thread_list", {"projectId": project, "includeSubagents": True, "limit": 100}
    )
    children = [
        t for t in listed.get("threads") or [] if t.get("parentThreadId") == parent
    ]
    if not children:
        raise CheckFailed(
            "parent %s made no child thread; parent said %r"
            % (parent, last_reply(shown)[:120])
        )
    child = children[0]["threadId"]
    code, out = t3(ctx, name, deadline, "thread show", "--json", child, cap=60)
    if fruit not in last_reply(json.loads(out)):
        raise CheckFailed("child %s did not reply with the fruit label" % child)
    queue = mcp.call("t3_queue", {"action": "list", "threadId": parent})
    code, _ = t3(
        ctx,
        name,
        deadline,
        "thread send",
        parent,
        "Reply with exactly the word SENT and nothing else.",
        cap=60,
    )
    if code != 0:
        raise CheckFailed("t3 thread send exited %d" % code)
    sent = wait_for(
        ctx, name, deadline, parent, lambda view: first_line(last_reply(view)) == "SENT"
    )
    if "SENT" not in last_reply(sent):
        raise CheckFailed("follow-up send got %r" % last_reply(sent)[:80])
    return (
        "parent %s delegated child %s, relayed its fruit label, t3_queue list held %d items, thread send answered SENT"
        % (
            parent,
            child,
            len(queue.get("items") or []),
        )
    )


CHECKS = [
    ("mcp-tools", 120, mcp_tools),
    ("agent-tools", 420, agent_tools),
]
