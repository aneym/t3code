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
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";

import { credentialValues, redact, redactTokens } from "./secretText.ts";

const LEGACY_VERSION = "2025-06-18";
const BETA_VERSION = "2026-07-28";
const EXTENSION = "io.modelcontextprotocol/events";
const HEADER_DIR = NodePath.join(NodeOS.homedir(), ".config", "t3-mcp-events");
const CALL_TIMEOUT = Duration.seconds(45);

export class McpEventsRpcError extends Schema.TaggedError<McpEventsRpcError>()(
  "McpEventsRpcError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.Number),
    reason: Schema.optional(Schema.String),
  },
) {}

interface RpcMessage {
  readonly id?: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown };
  readonly method?: string;
  readonly params?: unknown;
}

const clientInfo = { name: "t3code-mcp-events", version: "1" };
const capabilities = { extensions: { [EXTENSION]: {} } };
const initializeParams = {
  protocolVersion: LEGACY_VERSION,
  capabilities,
  clientInfo,
};
const betaMeta = {
  "io.modelcontextprotocol/protocolVersion": BETA_VERSION,
  "io.modelcontextprotocol/clientInfo": clientInfo,
  "io.modelcontextprotocol/clientCapabilities": capabilities,
};
const discover = { jsonrpc: "2.0", id: 0, method: "server/discover", params: { _meta: betaMeta } };

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

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

function paramsCredentials(params: unknown): ReadonlyArray<string> {
  const delivery = asRecord(asRecord(params).delivery);
  if (typeof delivery.url !== "string") return [];
  return credentialValues(
    delivery.url,
    typeof delivery.secret === "string" ? delivery.secret : undefined,
  );
}

function rpcFailure(
  message: RpcMessage,
  method: string,
  hidden: ReadonlyArray<string>,
): McpEventsRpcError | undefined {
  const error: unknown = message.error;
  if (error === undefined || error === null) return undefined;
  const fields = asRecord(error);
  const data = asRecord(fields.data);
  const clean = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() !== ""
      ? redactTokens(redact(value.trim(), hidden)).slice(0, max)
      : undefined;
  const reason = clean(data.reason, 60);
  const body = clean(data.body, 120);
  const detail = [
    typeof data.status === "number" ? `HTTP ${data.status}` : undefined,
    reason,
    body === undefined ? undefined : `body ${JSON.stringify(body)}`,
  ].filter((part) => part !== undefined);
  const text = clean(fields.message, 80) ?? "error";
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

function supportsBeta(result: unknown): boolean {
  const versions = asRecord(result).supportedVersions;
  return Array.isArray(versions) && versions.includes(BETA_VERSION);
}

function checkExtension(result: unknown) {
  const extensions = asRecord(asRecord(asRecord(result).capabilities).extensions);
  return Object.hasOwn(extensions, EXTENSION)
    ? undefined
    : new McpEventsRpcError({ message: "Server does not advertise MCP Events.", code: -32601 });
}

const request = (method: string, params: unknown, beta: boolean) => ({
  jsonrpc: "2.0",
  id: 2,
  method,
  params: beta
    ? { ...asRecord(params), _meta: { ...asRecord(asRecord(params)._meta), ...betaMeta } }
    : params,
});

const headerValue = (name: string) =>
  /^[\x20-\x7e]+$/.test(name) && name === name.trim() && !/^=\?base64\?.*\?=$/.test(name)
    ? name
    : `=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`;

const httpMessages = Effect.fn("McpEvents.httpMessages")(function* (
  server: Extract<McpEventsServer, { readonly url: string }>,
  method: string,
  params: unknown,
) {
  if (
    ["events/poll", "events/stream", "events/subscribe", "events/unsubscribe"].includes(method) &&
    typeof asRecord(params).name !== "string"
  ) {
    return yield* new McpEventsRpcError({ message: `${method} requires an event name.` });
  }
  const http = yield* HttpClient.HttpClient;
  const fileHeaders =
    server.headersFile === undefined ? {} : yield* readHeaderFile(server.headersFile);
  const post = (
    body: { jsonrpc: string; id?: number; method: string; params?: unknown },
    extra: Record<string, string>,
  ) =>
    http
      .execute(
        HttpClientRequest.post(server.url).pipe(
          HttpClientRequest.setHeaders({
            ...fileHeaders,
            accept: "application/json, text/event-stream",
            ...extra,
            "mcp-method": body.method,
            ...(typeof asRecord(body.params).name === "string"
              ? { "mcp-name": headerValue(asRecord(body.params).name as string) }
              : {}),
          }),
          HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
        ),
      )
      .pipe(
        Effect.mapError(
          () => new McpEventsRpcError({ message: `Could not reach ${serverLabel(server)}.` }),
        ),
      );
  const read = (response: HttpClientResponse.HttpClientResponse) =>
    response.text.pipe(
      Effect.map((text) => parseMessages(text, response.headers["content-type"])),
      Effect.mapError(
        () => new McpEventsRpcError({ message: `Could not read ${serverLabel(server)} reply.` }),
      ),
    );
  const betaHeaders = { "mcp-protocol-version": BETA_VERSION };
  const discovery = yield* post(discover, betaHeaders).pipe(
    Effect.flatMap(read),
    Effect.map((messages) => messages.find((message) => message.id === 0)?.result),
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => undefined),
  );
  let response;
  if (supportsBeta(discovery)) {
    const failure = checkExtension(discovery);
    if (failure !== undefined) return yield* failure;
    response = yield* post(request(method, params, true), betaHeaders);
  } else {
    const init = yield* post(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams },
      {},
    );
    if (init.status >= 400) {
      return yield* new McpEventsRpcError({
        message: `${serverLabel(server)} refused initialize (HTTP ${init.status}).`,
      });
    }
    const messages = yield* read(init);
    const answer = messages.find((message) => message.id === 1);
    if (answer === undefined)
      return yield* new McpEventsRpcError({ message: "No initialize reply." });
    const initFailure = rpcFailure(answer, "initialize", paramsCredentials(params));
    if (initFailure) return yield* initFailure;
    const sessionId = init.headers["mcp-session-id"];
    const session: Record<string, string> = {
      "mcp-protocol-version":
        typeof asRecord(answer.result).protocolVersion === "string"
          ? (asRecord(answer.result).protocolVersion as string)
          : LEGACY_VERSION,
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    };
    yield* post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    response = yield* post(request(method, params, false), session);
  }
  if (response.headers["content-type"]?.includes("text/event-stream")) {
    let data: string[] = [];
    return response.stream.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.flatMap((line) => {
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        if (line !== "" || data.length === 0) return Stream.empty;
        const messages = parseMessages(data.join("\n"), undefined);
        data = [];
        return Stream.fromIterable(messages);
      }),
      Stream.mapError(() => new McpEventsRpcError({ message: `${method} stream disconnected.` })),
    );
  }
  const messages = yield* read(response);
  if (messages.length === 0)
    return yield* new McpEventsRpcError({
      message: `${method} got no JSON-RPC answer (HTTP ${response.status}).`,
    });
  return Stream.fromIterable(messages);
});

const stdioMessages = (
  server: Extract<McpEventsServer, { readonly command: string }>,
  method: string,
  params: unknown,
) =>
  Stream.callback<RpcMessage, McpEventsRpcError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const child = NodeChildProcess.spawn(server.command, [...(server.args ?? [])], {
          stdio: ["pipe", "pipe", "ignore"],
        });
        let buffer = "";
        let done = false;
        let discovered = false;
        const finish = (error: McpEventsRpcError) => {
          if (done) return;
          done = true;
          Queue.failCauseUnsafe(queue, Cause.fail(error));
        };
        const send = (message: unknown) => {
          if (!done && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
        };
        child.stdin.on("error", () =>
          finish(new McpEventsRpcError({ message: `${serverLabel(server)} closed its input.` })),
        );
        child.on("error", () =>
          finish(new McpEventsRpcError({ message: `Could not start ${serverLabel(server)}.` })),
        );
        child.on("exit", () =>
          finish(new McpEventsRpcError({ message: `${serverLabel(server)} exited.` })),
        );
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          try {
            onData(chunk);
          } catch {
            finish(new McpEventsRpcError({ message: `${serverLabel(server)} sent a bad reply.` }));
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
              if (message.id === 0 && !discovered) {
                clearTimeout(probe);
                if (!supportsBeta(message.result)) startLegacy();
                else {
                  discovered = true;
                  const failure = checkExtension(message.result);
                  if (failure !== undefined) return finish(failure);
                  send(request(method, params, true));
                }
              } else if (message.id === 1) {
                const failure = rpcFailure(message, "initialize", paramsCredentials(params));
                if (failure) return finish(failure);
                send({ jsonrpc: "2.0", method: "notifications/initialized" });
                send(request(method, params, false));
              } else if (message.id === 2 || message.method?.startsWith("notifications/events/"))
                Queue.offerUnsafe(queue, message);
            }
          }
        };
        const startLegacy = () => {
          discovered = true;
          send({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams });
        };
        // @effect-diagnostics-next-line globalTimersInEffect:off -- The timer belongs to the child process callback lifecycle.
        const probe = setTimeout(startLegacy, 1500);
        send(discover);
        return () => {
          done = true;
          clearTimeout(probe);
          child.stdin.end();
          child.kill();
        };
      }),
      (close) => Effect.sync(close),
    ),
  );

const messagesFor = (server: McpEventsServer, method: string, params: unknown) =>
  "url" in server
    ? Stream.unwrap(httpMessages(server, method, params))
    : stdioMessages(server, method, params);

export const callEventsMethod = (server: McpEventsServer, method: string, params: unknown) =>
  messagesFor(server, method, params).pipe(
    Stream.filter((message) => message.id === 2),
    Stream.runHead,
    Effect.flatMap((answer) => {
      if (answer._tag === "None")
        return Effect.fail(new McpEventsRpcError({ message: `${method} got no JSON-RPC answer.` }));
      const error = rpcFailure(answer.value, method, paramsCredentials(params));
      return error ? Effect.fail(error) : Effect.succeed(answer.value.result);
    }),
    Effect.timeoutOrElse({
      duration: CALL_TIMEOUT,
      orElse: () =>
        Effect.fail(new McpEventsRpcError({ message: `${method} timed out.`, reason: "timeout" })),
    }),
  );

export const streamEvents = (server: McpEventsServer, params: unknown) =>
  messagesFor(server, "events/stream", params).pipe(
    Stream.mapEffect((message) => {
      const error = rpcFailure(message, "events/stream", []);
      return error ? Effect.fail(error) : Effect.succeed(message);
    }),
    Stream.timeout("45 seconds"),
  );
