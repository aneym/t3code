// @effect-diagnostics nodeBuiltinImport:off - fakes the owner MCP endpoint at the Node HTTP boundary.
import * as NodeFS from "node:fs";
import type * as NodeHttp from "node:http";
import * as NodePath from "node:path";

const FAKE_PAIRING_CREDENTIAL = "PAIRTEST2345";

const toolResults: Readonly<Record<string, unknown>> = {
  t3_auth_session_issue: { sessionId: "issued-test-session", token: "issued-test-token" },
  t3_auth_session_revoke: { revoked: true },
  t3_auth_pairing_create: {
    credential: FAKE_PAIRING_CREDENTIAL,
    expiresAt: "2100-01-01T00:00:00.000Z",
  },
};

export const publishOwnerCliCredential = (stateDir: string) => {
  const secretsDir = NodePath.join(stateDir, "secrets");
  NodeFS.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(
    NodePath.join(secretsDir, "owner-cli-session.json"),
    JSON.stringify({
      sessionId: "owner-cli-test",
      token: "owner-cli-test-token",
      expiresAtMs: 4_102_444_800_000,
    }),
    { mode: 0o600 },
  );
};

type McpMessage = {
  readonly id?: string;
  readonly method: string;
  readonly params?: { readonly name?: string; readonly arguments?: unknown };
};

export const makeOwnerMcpFake = () => {
  const calls: Array<string> = [];
  const callArguments: Array<unknown> = [];
  const answer = (body: string) => {
    const message = JSON.parse(body) as McpMessage;
    if (message.id === undefined) return { status: 202, body: "" };
    const name = message.params?.name ?? "";
    if (message.method === "tools/call") {
      calls.push(name);
      callArguments.push(message.params?.arguments);
    }
    const result =
      message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } }
        : { content: [], structuredContent: toolResults[name] };
    return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) };
  };
  const headers = { "content-type": "application/json", "mcp-session-id": "fake" };
  const handle = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    if (request.url !== "/mcp") return false;
    if (request.method !== "POST") {
      response.writeHead(200);
      response.end();
      return true;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const reply = answer(body);
      response.writeHead(reply.status, reply.status === 200 ? headers : {});
      response.end(reply.body);
    });
    return true;
  };
  const fetchFor =
    (next: typeof globalThis.fetch): typeof globalThis.fetch =>
    async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/mcp") return next(input, init);
      if (init?.method !== "POST") return new Response(null, { status: 200 });
      const reply = answer(String(init.body));
      return new Response(reply.status === 200 ? reply.body : null, {
        status: reply.status,
        headers: reply.status === 200 ? headers : {},
      });
    };
  return { calls, callArguments, handle, fetchFor };
};

export type OwnerMcpFake = ReturnType<typeof makeOwnerMcpFake>;

export const ownerMcpFetch = (baseDir: string, next: typeof globalThis.fetch) => {
  publishOwnerCliCredential(NodePath.join(baseDir, "userdata"));
  return makeOwnerMcpFake().fetchFor(next);
};
