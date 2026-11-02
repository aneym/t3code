import { existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
const record = (observation) => appendFileSync(`${root}observations.ndjson`, JSON.stringify({ observation, at: new Date().toISOString() }) + "\n");
export async function drainTurn(params, sessionId, count, send, signal) {
  const prompt = JSON.stringify(params.prompt);
  const reply = (text) => send({method: "session/update", params: {sessionId, update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text}}}});
  if (prompt.includes("DRAIN_PARENT") && count === 1) {
    let session;
    let id = 0;
    const post = async (method, params) => {
      const response = await fetch(process.env.T3_ACP_MCP_ENDPOINT, {method: "POST", headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        Authorization: process.env.T3_ACP_MCP_AUTHORIZATION,
        ...(session ? {"Mcp-Session-Id": session} : {}),
      }, body: JSON.stringify({jsonrpc: "2.0", id: ++id, method, params})});
      session = response.headers.get("mcp-session-id") ?? session;
      if (!response.ok) throw new Error(`Replay MCP HTTP ${response.status}`);
      const raw = await response.text();
      const result = JSON.parse(raw.startsWith("{") ? raw : raw.split("\n").filter(x => x.startsWith("data:")).at(-1).slice(5));
      if (result.error || result.result?.isError) throw new Error("Replay MCP call failed");
      return result.result;
    };
    await post("initialize", {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "replay-drain", version: "1"}});
    await post("tools/call", {name: "orchestrator_capabilities", arguments: {}});
    await post("tools/call", {name: "delegate_task", arguments: {task: "DRAIN_CHILD", target: {providerInstanceId: "drainReplay", model: "showcase"}, mode: "async", clientRequestId: "drain-child"}});
    record("parent-called-delegate-task-through-mcp");
    const deadline = Date.now() + 240000;
    while (!existsSync(`${root}parent-release`) && !signal.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!existsSync(`${root}parent-release`)) throw new Error("Replay parent setup deadline");
    reply("Delegated; waiting for child.");
    record("parent-provider-turn-returned");
  } else if (prompt.includes("DRAIN_CHILD") && !prompt.includes("DRAIN_PARENT")) {
    record("child-hold-entered");
    reply("CHILD_HOLD");
    const deadline = Date.now() + 240000;
    while (!existsSync(`${root}release`) && !signal.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (signal.aborted) { record("child-cut"); return; }
    if (!existsSync(`${root}release`)) throw new Error("Replay child release deadline");
    record("child-released");
    reply("CHILD_FINISHED");
  } else {
    record(prompt.includes("CHILD_FINISHED") ? "parent-received-child-completion" : "parent-resumed-without-child-marker");
    reply(prompt.includes("CHILD_FINISHED") ? "PARENT_RECEIVED_CHILD_FINISHED" : "PARENT_MISSING_CHILD_RESULT");
  }
}
