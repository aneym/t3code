// @effect-diagnostics-next-line nodeBuiltinImport:off -- Stdio MCP servers are plain child processes.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Header files are read once per call.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- O_NOFOLLOW lives on the fs constants.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The header dir check runs inside the same promise.
import * as NodePath from "node:path";

import type { McpEventsServer } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const PROTOCOL_VERSION = "2025-06-18";
const HEADER_DIR = NodePath.join(NodeOS.homedir(), ".config", "t3-mcp-events");
const CALL_TIMEOUT = Duration.seconds(45);

export class McpEventsRpcError extends Data.TaggedError("McpEventsRpcError")<{
  readonly message: string;
  readonly code?: number;
  readonly reason?: string;
}> {}

interface RpcMessage {
  readonly id?: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
}

const initializeParams = {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: { extensions: { "io.modelcontextprotocol/events": {} } },
  clientInfo: { name: "t3code-mcp-events", version: "1" },
};

export function serverKey(server: McpEventsServer): string {
  return "url" in server
    ? `http ${server.url}`
    : `stdio ${JSON.stringify([server.command, ...(server.args ?? [])])}`;
}

export function serverLabel(server: McpEventsServer): string {
  if ("url" in server) {
    try {
      return new URL(server.url).host;
    } catch {
      return server.url;
    }
  }
  return server.command.split("/").at(-1) ?? server.command;
}

function rpcFailure(message: RpcMessage, method: string): McpEventsRpcError | undefined {
  const error: unknown = message.error;
  if (error === undefined || error === null) return undefined;
  const fields = typeof error === "object" ? (error as Record<string, unknown>) : {};
  const data =
    typeof fields.data === "object" && fields.data !== null
      ? (fields.data as Record<string, unknown>)
      : {};
  const reason = typeof data.reason === "string" ? data.reason : undefined;
  const detail = [
    reason,
    typeof data.status === "number" ? `HTTP ${data.status}` : undefined,
    typeof data.body === "string" && data.body.trim() !== ""
      ? `body ${JSON.stringify(data.body.trim().slice(0, 160))}`
      : undefined,
  ].filter((part) => part !== undefined);
  const text = typeof fields.message === "string" ? fields.message : "error";
  return new McpEventsRpcError({
    message: `${method} failed: ${text}${detail.length > 0 ? ` (${detail.join(", ")})` : ""}`,
    ...(typeof fields.code === "number" ? { code: fields.code } : {}),
    ...(reason === undefined ? {} : { reason }),
  });
}

function parseMessages(text: string, contentType: string | undefined): ReadonlyArray<RpcMessage> {
  const payloads = contentType?.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
    : [text];
  const messages: RpcMessage[] = [];
  for (const payload of payloads) {
    if (payload === "") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (typeof item === "object" && item !== null) messages.push(item as RpcMessage);
      }
    } catch {
      continue;
    }
  }
  return messages;
}

const readHeaderFile = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const expanded = path.replace(/^~(?=\/)/, NodeOS.homedir());
      const dir = await NodeFSP.realpath(HEADER_DIR);
      if ((await NodeFSP.realpath(NodePath.dirname(expanded))) !== dir) {
        throw new Error("outside header dir");
      }
      const handle = await NodeFSP.open(
        NodePath.join(dir, NodePath.basename(expanded)),
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      try {
        if (!(await handle.stat()).isFile()) throw new Error("not a file");
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    },
    catch: () =>
      new McpEventsRpcError({
        message: "headersFile must be a readable file directly in ~/.config/t3-mcp-events/.",
      }),
  }).pipe(
    Effect.map((text) => {
      const headers: Record<string, string> = {};
      for (const line of text.split(/\r?\n/)) {
        const index = line.indexOf(":");
        if (index <= 0) continue;
        headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      return headers;
    }),
  );

const callHttp = Effect.fn("McpEvents.callHttp")(function* (
  server: Extract<McpEventsServer, { readonly url: string }>,
  method: string,
  params: unknown,
) {
  const http = yield* HttpClient.HttpClient;
  const fileHeaders =
    server.headersFile === undefined ? {} : yield* readHeaderFile(server.headersFile);
  const post = (body: unknown, extra: Record<string, string>) =>
    http
      .execute(
        HttpClientRequest.post(server.url).pipe(
          HttpClientRequest.setHeaders({
            ...fileHeaders,
            accept: "application/json, text/event-stream",
            ...extra,
          }),
          HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.text.pipe(
            Effect.map((text) => ({
              status: response.status,
              headers: response.headers,
              messages: parseMessages(text, response.headers["content-type"]),
            })),
          ),
        ),
        Effect.mapError(
          () => new McpEventsRpcError({ message: `Could not reach ${serverLabel(server)}.` }),
        ),
      );
  const init = yield* post(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams },
    {},
  );
  if (init.status >= 400) {
    return yield* new McpEventsRpcError({
      message: `${serverLabel(server)} refused initialize (HTTP ${init.status}).`,
    });
  }
  const initFailure = init.messages[0] && rpcFailure(init.messages[0], "initialize");
  if (initFailure) return yield* initFailure;
  const sessionId = init.headers["mcp-session-id"];
  const session: Record<string, string> = {
    "mcp-protocol-version": PROTOCOL_VERSION,
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  };
  yield* post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const response = yield* post({ jsonrpc: "2.0", id: 2, method, params }, session);
  const message = response.messages.find((candidate) => candidate.id === 2);
  if (message === undefined) {
    return yield* new McpEventsRpcError({
      message: `${method} got no JSON-RPC answer (HTTP ${response.status}).`,
    });
  }
  const failure = rpcFailure(message, method);
  if (failure) return yield* failure;
  return message.result;
});

const callStdio = (
  server: Extract<McpEventsServer, { readonly command: string }>,
  method: string,
  params: unknown,
) =>
  Effect.callback<unknown, McpEventsRpcError>((resume) => {
    const child = NodeChildProcess.spawn(server.command, [...(server.args ?? [])], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let done = false;
    const finish = (effect: Effect.Effect<unknown, McpEventsRpcError>) => {
      if (done) return;
      done = true;
      child.stdin.end();
      child.kill();
      resume(effect);
    };
    const send = (message: unknown) => {
      if (!done && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.stdin.on("error", () =>
      finish(
        Effect.fail(new McpEventsRpcError({ message: `${serverLabel(server)} closed its input.` })),
      ),
    );
    child.on("error", () =>
      finish(
        Effect.fail(new McpEventsRpcError({ message: `Could not start ${serverLabel(server)}.` })),
      ),
    );
    child.on("exit", () =>
      finish(
        Effect.fail(
          new McpEventsRpcError({ message: `${serverLabel(server)} exited before answering.` }),
        ),
      ),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      try {
        onData(chunk);
      } catch {
        finish(
          Effect.fail(
            new McpEventsRpcError({ message: `${serverLabel(server)} sent a bad reply.` }),
          ),
        );
      }
    });
    const onData = (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        for (const message of parseMessages(line, undefined)) {
          if (message.id === 1) {
            const failure = rpcFailure(message, "initialize");
            if (failure) return finish(Effect.fail(failure));
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({ jsonrpc: "2.0", id: 2, method, params });
          } else if (message.id === 2) {
            const failure = rpcFailure(message, method);
            return finish(failure ? Effect.fail(failure) : Effect.succeed(message.result));
          }
        }
      }
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
    return Effect.sync(() => {
      done = true;
      child.kill();
    });
  });

export const callEventsMethod = (server: McpEventsServer, method: string, params: unknown) =>
  ("url" in server ? callHttp(server, method, params) : callStdio(server, method, params)).pipe(
    Effect.timeoutOrElse({
      duration: CALL_TIMEOUT,
      orElse: () =>
        Effect.fail(new McpEventsRpcError({ message: `${method} timed out.`, reason: "timeout" })),
    }),
  );
