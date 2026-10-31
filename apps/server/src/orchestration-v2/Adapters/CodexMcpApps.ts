import type {
  ThreadId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { snapshotMcpApp } from "../../mcpApps/McpAppSnapshot.ts";
import { MCP_APP_MAX_HTML_BYTES, MCP_APP_RESOURCE_SCHEME } from "@t3tools/shared/mcpApp";

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

export function codexMcpAppResourceUri(item: unknown): string | undefined {
  if (field(item, "type") !== "mcpToolCall") return undefined;
  const candidates = [
    field(field(field(field(item, "result"), "_meta"), "ui"), "resourceUri"),
    field(field(item, "mcpAppUi"), "resourceUri"),
    field(item, "mcpAppResourceUri"),
    field(field(item, "appContext"), "resourceUri"),
  ];
  return candidates.find(
    (uri): uri is string => typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME),
  );
}

type Resource = { readonly contents: ReadonlyArray<unknown> };
type Call = { readonly id: string; readonly server: string };

export const makeCodexMcpAppPrefetch = Effect.fn("CodexMcpApps.makePrefetch")(function* <E>(
  read: (threadId: string, server: string, uri: string) => Effect.Effect<Resource, E>,
) {
  const scope = yield* Scope.Scope;
  const pending = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      server: string;
      uri: string;
      response: Deferred.Deferred<Resource | undefined>;
      fiber: Fiber.Fiber<void, unknown>;
    }
  >();
  yield* Effect.addFinalizer(() => Effect.sync(() => pending.clear()));
  const key = (threadId: string, turnId: string, item: Call) =>
    JSON.stringify([threadId, turnId, item.id]);
  const discard = Effect.fn("CodexMcpApps.discard")(function* (id: string) {
    const entry = pending.get(id);
    pending.delete(id);
    if (entry) yield* Fiber.interrupt(entry.fiber);
  });
  return {
    start: Effect.fn("CodexMcpApps.prefetch")(function* (
      threadId: string,
      turnId: string,
      item: Call,
    ) {
      const uri = codexMcpAppResourceUri(item);
      const id = key(threadId, turnId, item);
      if (!uri || field(item, "readOnlyHint") !== true || pending.has(id) || pending.size >= 64)
        return;
      const response = yield* Deferred.make<Resource | undefined>();
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Deferred.await(ready).pipe(
        Effect.andThen(read(threadId, item.server, uri)),
        // A hung MCP resource read must not hold run ingestion open.
        Effect.timeout("20 seconds"),
        Effect.map((resource) =>
          Buffer.byteLength(JSON.stringify(resource), "utf8") <= MCP_APP_MAX_HTML_BYTES
            ? resource
            : undefined,
        ),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          () => Effect.void,
        ),
        Effect.flatMap((resource) => Deferred.succeed(response, resource || undefined)),
        Effect.andThen(Effect.sleep("25 seconds")),
        Effect.andThen(
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      pending.set(id, { threadId, turnId, server: item.server, uri, response, fiber });
      yield* Deferred.succeed(ready, undefined);
    }),
    discard: (threadId: string, turnId: string, item: Call) => discard(key(threadId, turnId, item)),
    clearTurn: (turnId: string) =>
      Effect.forEach(
        [...pending].filter(([, entry]) => entry.turnId === turnId),
        ([id]) => discard(id),
        { discard: true },
      ),
    clearThread: (threadId: string) =>
      Effect.forEach(
        [...pending].filter(([, entry]) => entry.threadId === threadId),
        ([id]) => discard(id),
        { discard: true },
      ),
    capture: Effect.fn("CodexMcpApps.capture")(function* (input: {
      nativeThreadId: string;
      nativeTurnId: string;
      item: Call;
      threadId: ThreadId;
      attachmentsDir: string;
      tool: string;
      resourceUri: string;
    }) {
      const id = key(input.nativeThreadId, input.nativeTurnId, input.item);
      const entry = pending.get(id);
      pending.delete(id);
      const resource =
        entry?.server === input.item.server &&
        entry.uri === input.resourceUri &&
        field(field(field(field(input.item, "result"), "_meta"), "ui"), "resourceUri") === entry.uri
          ? yield* Deferred.await(entry.response).pipe(
              Effect.ensuring(Fiber.interrupt(entry.fiber)),
            )
          : undefined;
      if (entry && resource === undefined) yield* Fiber.interrupt(entry.fiber);
      const response =
        resource ??
        (yield* read(input.nativeThreadId, input.item.server, input.resourceUri).pipe(
          Effect.timeout("20 seconds"),
        ));
      return yield* snapshotMcpApp({
        ...input,
        server: input.item.server,
        contents: response.contents,
      });
    }),
  };
});

export function codexMcpToolOutput(item: {
  readonly result?: { readonly structuredContent?: unknown; readonly content: unknown } | null;
  readonly error?: { readonly message: string } | null;
}): unknown | undefined {
  const resultOutput =
    item.result === null || item.result === undefined
      ? undefined
      : item.result.structuredContent !== null && item.result.structuredContent !== undefined
        ? item.result.structuredContent
        : item.result.content;

  if (item.error === null || item.error === undefined) {
    return resultOutput;
  }
  return resultOutput === undefined
    ? { error: item.error.message }
    : { error: item.error.message, result: resultOutput };
}

export function codexDynamicToolOutput(item: {
  readonly contentItems?: unknown;
  readonly success?: boolean | null;
}): unknown | undefined {
  if (item.contentItems !== null && item.contentItems !== undefined) {
    return item.contentItems;
  }
  return item.success === false ? { success: false } : undefined;
}

export function codexItemStatus(status: "inProgress" | "completed" | "failed" | "declined"): {
  readonly node: OrchestrationV2ExecutionNode["status"];
  readonly turnItem: OrchestrationV2TurnItem["status"];
  readonly completed: boolean;
} {
  switch (status) {
    case "inProgress":
      return { node: "running", turnItem: "running", completed: false };
    case "completed":
      return {
        node: "completed",
        turnItem: "completed",
        completed: true,
      };
    case "failed":
      return { node: "failed", turnItem: "failed", completed: true };
    case "declined":
      return {
        node: "cancelled",
        turnItem: "cancelled",
        completed: true,
      };
  }
}
