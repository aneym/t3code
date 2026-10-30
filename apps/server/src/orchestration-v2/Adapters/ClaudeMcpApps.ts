import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind, type ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { readMcpAppResourceUri } from "@t3tools/shared/mcpApp";
import * as Effect from "effect/Effect";
import { snapshotMcpApp } from "../../mcpApps/McpAppSnapshot.ts";
import { field } from "../unknownField.ts";

type Prefetch = { server: string; uri: string; response: unknown } | undefined;
type Entry = { uri?: string; server: string; promise: Promise<Prefetch>; abort: AbortController };
const pending = new WeakMap<object, Map<string, Entry>>();

function toolParts(name: string) {
  if (!name.startsWith("mcp__")) return undefined;
  const [, server, ...parts] = name.replace(/^mcp__claude_ai_/u, "mcp__").split("__");
  const tool = parts.join("__");
  return server === undefined || tool.length === 0 ? undefined : { server, tool };
}

export function claudeMcpQueryMessages<T>(
  query: Query,
  messages: AsyncIterable<T>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = messages[Symbol.asyncIterator]();
      return {
        async next() {
          const result = await iterator.next();
          const message = result.value;
          const calls = pending.get(query);
          if (result.done) {
            calls?.forEach((entry) => entry.abort.abort());
            calls?.clear();
          }
          if (!result.done && field(message, "type") === "assistant") {
            const content = field(field(message, "message"), "content");
            for (const block of Array.isArray(content) ? content : []) {
              const id = field(block, "id");
              const name = field(block, "name");
              const parts = typeof name === "string" ? toolParts(name) : undefined;
              if (
                field(block, "type") !== "tool_use" ||
                typeof id !== "string" ||
                !parts ||
                !calls ||
                calls.has(id) ||
                calls.size >= 64
              )
                continue;
              const { server, tool } = parts;
              const abort = new AbortController();
              const entry: Entry = { server, abort, promise: Promise.resolve(undefined) };
              const prefetch = Effect.runPromise(
                Effect.tryPromise({
                  try: async (signal) => {
                    const servers = await query.mcpServerStatus();
                    if (signal.aborted) return undefined;
                    const definition = findTool(serverTools(servers, server), tool);
                    const uri = readMcpAppResourceUri(field(definition, "_meta"));
                    if (uri === undefined || abort.signal.aborted) return undefined;
                    entry.uri = uri;
                    const response = await query.readMcpResource(server, uri);
                    return { server, uri, response };
                  },
                  catch: () => undefined,
                }).pipe(
                  Effect.timeout("20 seconds"),
                  Effect.orElseSucceed(() => undefined),
                ),
              );
              entry.promise = prefetch;
              calls.set(id, entry);
              void Effect.runPromise(Effect.sleep("25 seconds"), { signal: abort.signal })
                .then(() => {
                  if (calls.get(id) === entry) calls.delete(id);
                  abort.abort();
                })
                .catch(() => undefined);
            }
          }
          return result;
        },
        ...(iterator.return
          ? {
              return: (...args: Parameters<NonNullable<typeof iterator.return>>) => {
                const calls = pending.get(query);
                calls?.forEach((entry) => entry.abort.abort());
                calls?.clear();
                return iterator.return!(...args);
              },
            }
          : {}),
        ...(iterator.throw
          ? {
              throw: (...args: Parameters<NonNullable<typeof iterator.throw>>) => {
                const calls = pending.get(query);
                calls?.forEach((entry) => entry.abort.abort());
                calls?.clear();
                return iterator.throw!(...args);
              },
            }
          : {}),
      };
    },
  };
}

export interface ClaudeMcpQuery<E> {
  readonly mcpServerStatus?: Effect.Effect<ReadonlyArray<unknown>, E>;
  readonly readMcpResource?: (server: string, uri: string) => Effect.Effect<unknown, E>;
  readonly callMcpTool?: (tool: string, args: Record<string, unknown>) => Effect.Effect<unknown, E>;
}

export function claudeMcpQuerySession<E>(
  query: Query,
  makeError: (cause: unknown, method: string) => E,
): ClaudeMcpQuery<E> {
  const calls = new Map<string, Entry>();
  pending.set(query, calls);
  const session: ClaudeMcpQuery<E> = {
    mcpServerStatus: Effect.tryPromise({
      try: () => query.mcpServerStatus(),
      catch: (cause) => makeError(cause, "mcpServerStatus"),
    }),
    readMcpResource: (server, uri) =>
      Effect.tryPromise({
        try: () => query.readMcpResource(server, uri),
        catch: (cause) => makeError(cause, "readMcpResource"),
      }),
    callMcpTool: (tool, args) =>
      Effect.tryPromise({
        try: async () => {
          const control = query as unknown as {
            request: (request: {
              subtype: "mcp_call";
              tool: string;
              arguments: Record<string, unknown>;
              result_not_for_model: true;
            }) => Promise<{ response: unknown }>;
          };
          const result = await control.request({
            subtype: "mcp_call",
            tool,
            arguments: args,
            result_not_for_model: true,
          });
          return result.response;
        },
        catch: (cause) => makeError(cause, "mcpCall"),
      }),
  };
  pending.set(session.readMcpResource!, calls);
  return session;
}

function serverTools(servers: ReadonlyArray<unknown>, server: string) {
  const tools = field(
    servers.find((entry) => field(entry, "name") === server),
    "tools",
  );
  return Array.isArray(tools) ? tools : [];
}

function findTool(tools: ReadonlyArray<unknown>, name: string) {
  const exact = tools.find((tool) => field(tool, "name") === name);
  if (exact !== undefined) return exact;
  const matches = tools.filter((tool) => {
    const candidate = field(tool, "name");
    return typeof candidate === "string" && candidate.replace(/[^a-zA-Z0-9_-]/gu, "_") === name;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function resultUri(values: ReadonlyArray<unknown>) {
  for (const value of values) {
    const uri = readMcpAppResourceUri(value) ?? readMcpAppResourceUri(field(value, "_meta"));
    if (uri !== undefined) return uri;
  }
  return undefined;
}

export const captureClaudeMcpApp = Effect.fn("ClaudeMcpApps.capture")(function* <E>(input: {
  readonly query: ClaudeMcpQuery<E>;
  readonly threadId: ThreadId;
  readonly attachmentsDir: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly toolResult: unknown;
}) {
  const parts = toolParts(input.toolName);
  if (parts === undefined || input.query.readMcpResource === undefined) return undefined;
  const { server, tool } = parts;
  const id = field(input.toolResult, "tool_use_id");
  const calls = pending.get(input.query.readMcpResource);
  const prefetch = typeof id === "string" ? calls?.get(id) : undefined;
  if (typeof id === "string") calls?.delete(id);
  prefetch?.abort.abort();
  let resourceUri = resultUri([input.output, input.toolResult]);
  if (resourceUri === undefined && input.query.mcpServerStatus !== undefined) {
    const servers = yield* input.query.mcpServerStatus.pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => []),
    );
    const definition = findTool(serverTools(servers, server), tool);
    resourceUri = readMcpAppResourceUri(field(definition, "_meta"));
  }
  if (resourceUri === undefined) return undefined;
  const read =
    prefetch?.server !== server || prefetch.uri !== resourceUri
      ? input.query.readMcpResource(server, resourceUri)
      : Effect.promise(() => prefetch.promise).pipe(
          Effect.flatMap((value) =>
            value?.server === server && value.uri === resourceUri
              ? Effect.succeed(value.response)
              : input.query.readMcpResource!(server, resourceUri),
          ),
        );
  return yield* read.pipe(
    Effect.flatMap((response) => {
      const contents = field(response, "contents");
      return snapshotMcpApp({
        attachmentsDir: input.attachmentsDir,
        threadId: input.threadId,
        server,
        tool,
        resourceUri,
        contents: Array.isArray(contents) ? contents : [],
      });
    }),
    Effect.timeout("20 seconds"),
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to capture Claude MCP app; showing a plain tool row.", {
        server,
        tool,
        resourceUri,
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  );
});

export function makeClaudeMcpApps<E>(
  getQuery: Effect.Effect<ClaudeMcpQuery<E> | null>,
): ProviderAdapter.ProviderAdapterV2McpApps {
  const failure = (detail: string) => (cause: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: ProviderDriverKind.make("claudeAgent"),
      detail,
      payload: cause,
    });
  return {
    listTools: Effect.fn("ClaudeAdapterV2.listTools")(
      function* (input: Parameters<ProviderAdapter.ProviderAdapterV2McpApps["listTools"]>[0]) {
        const query = yield* getQuery;
        if (query?.mcpServerStatus === undefined) return [];
        const tools = serverTools(yield* query.mcpServerStatus, input.server);
        return tools.flatMap((tool): ProviderAdapter.ProviderAdapterV2McpTool[] => {
          const name = field(tool, "name");
          if (typeof name !== "string") return [];
          const rawAnnotations = field(tool, "annotations");
          const annotations: Record<string, boolean> = {};
          for (const [source, target] of [
            ["readOnly", "readOnlyHint"],
            ["destructive", "destructiveHint"],
            ["openWorld", "openWorldHint"],
          ]) {
            const value = field(rawAnnotations, source!);
            if (typeof value === "boolean") annotations[target!] = value;
          }
          const meta = field(tool, "_meta");
          return [{ name, ...(meta === undefined ? {} : { _meta: meta }), annotations }];
        });
      },
      Effect.mapError(failure("Failed to list Claude MCP tools.")),
    ),
    callTool: Effect.fn("ClaudeAdapterV2.callTool")(
      function* (input: Parameters<ProviderAdapter.ProviderAdapterV2McpApps["callTool"]>[0]) {
        const query = yield* getQuery;
        if (query?.callMcpTool === undefined)
          return yield* failure("Claude MCP tool calls are unavailable.")("no live query");
        return (yield* query.callMcpTool(
          `mcp__${input.server}__${input.tool}`,
          input.arguments,
        )) as ProviderAdapter.ProviderAdapterV2McpCallToolResult;
      },
      Effect.mapError(failure("Claude MCP tool call failed.")),
    ),
    readResource: Effect.fn("ClaudeAdapterV2.readResource")(
      function* (input: Parameters<ProviderAdapter.ProviderAdapterV2McpApps["readResource"]>[0]) {
        const query = yield* getQuery;
        if (query?.readMcpResource === undefined)
          return yield* failure("Claude MCP resource reads are unavailable.")("no live query");
        const result = yield* query.readMcpResource(input.server, input.uri);
        const contents = field(result, "contents");
        return { contents: Array.isArray(contents) ? contents : [] };
      },
      Effect.mapError(failure("Claude MCP resource read failed.")),
    ),
  };
}
