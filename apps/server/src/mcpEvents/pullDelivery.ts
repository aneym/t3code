import { McpEventOccurrence, type McpEventsServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { DeliveryOutcome } from "./eventDelivery.ts";
import { callEventsMethod, McpEventsRpcError, streamEvents } from "./eventsRpc.ts";
import * as Store from "./McpEventsStore.ts";
import { rpcMessage } from "./eventText.ts";

const Cursor = Schema.Struct({
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  truncated: Schema.optional(Schema.Boolean),
});
const PollResult = Schema.Struct({
  ...Cursor.fields,
  events: Schema.Array(McpEventOccurrence),
  hasMore: Schema.optional(Schema.Boolean),
  nextPollMs: Schema.optional(Schema.Number),
});
const Catalog = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      delivery: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeCatalog = Schema.decodeUnknownOption(Catalog);
const decodeCursor = Schema.decodeUnknownOption(Cursor);
const decodeOccurrence = Schema.decodeUnknownOption(McpEventOccurrence);
const decodePoll = Schema.decodeUnknownOption(PollResult);
const isRpcError = Schema.is(McpEventsRpcError);
const retry = (message: string) => new McpEventsRpcError({ message });

export const deliveryModes = Effect.fn("McpEvents.deliveryModes")(function* (
  server: McpEventsServer,
  name: string,
) {
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const catalog = yield* callEventsMethod(
      server,
      "events/list",
      cursor === undefined ? {} : { cursor },
    ).pipe(
      Effect.catchIf(
        (error) => error.code === -32601,
        () => Effect.undefined,
      ),
      Effect.map(decodeCatalog),
    );
    if (Option.isNone(catalog)) return ["webhook"];
    const descriptor = catalog.value.events.find((event) => event.name === name);
    if (descriptor !== undefined) return descriptor.delivery ?? ["webhook"];
    const next = catalog.value.nextCursor;
    if (!next || seen.has(next)) return ["webhook"];
    seen.add(next);
    cursor = next;
  }
});

export const runPull = Effect.fn("McpEvents.runPull")(function* <
  E extends { readonly message: string },
  R,
>(
  id: string,
  enabled: Effect.Effect<boolean>,
  deliver: (
    row: Store.SubscriptionRow,
    event: McpEventOccurrence,
  ) => Effect.Effect<DeliveryOutcome, E, R>,
) {
  while (yield* enabled) {
    const row = yield* Store.findById(id);
    if (row === undefined || row.status === "terminated" || row.delivery_mode === "webhook") return;
    const subscription = Store.toSubscription(row);
    const params = { name: row.name, arguments: subscription.arguments, cursor: row.cursor };
    const syncCursor = (payload: unknown) => {
      const position = Option.getOrUndefined(decodeCursor(payload));
      return position === undefined
        ? Effect.void
        : Store.saveCursor(
            id,
            position.cursor ?? null,
            position.truncated === true && position.cursor != null,
          );
    };
    const receive = Effect.fn("McpEvents.receivePulled")(function* (data: unknown) {
      const event = Option.getOrUndefined(decodeOccurrence(data));
      if (event === undefined || event.name !== row.name)
        return yield* retry("Invalid MCP event occurrence.");
      if ((yield* deliver(row, event)) === "unavailable") {
        return yield* retry("Thread is unavailable for MCP Events.");
      }
    });
    const poll = Effect.gen(function* () {
      const result = yield* callEventsMethod(subscription.server, "events/poll", params);
      const parsed = Option.getOrUndefined(decodePoll(result));
      if (parsed === undefined) return yield* retry("Invalid events/poll result.");
      for (const event of parsed.events) yield* receive(event);
      if (row.status !== "active") yield* Store.markStatus(id, "active", null);
      yield* syncCursor(parsed);
      return parsed.hasMore === true ? 0 : Math.max(1000, parsed.nextPollMs ?? 30_000);
    });
    let terminated = false;
    let active = false;
    const push = streamEvents(subscription.server, { ...params, heartbeatMs: 15_000 }).pipe(
      Stream.takeUntil(
        (message) => message.method === "notifications/events/terminated" || message.id === 2,
      ),
      Stream.runForEach((message) =>
        Effect.gen(function* () {
          if (!(yield* enabled)) return yield* retry("MCP Events is disabled.");
          switch (message.method) {
            case "notifications/events/active":
              if (!active && row.status !== "active") yield* Store.markStatus(id, "active", null);
              active = true;
              yield* syncCursor(message.params);
              break;
            case "notifications/events/heartbeat":
              yield* syncCursor(message.params);
              break;
            case "notifications/events/event":
              yield* receive(message.params);
              yield* syncCursor(message.params);
              break;
            case "notifications/events/error":
              yield* Store.markStatus(id, "active", "Event stream reported a recoverable error");
              break;
            case "notifications/events/terminated":
              terminated = true;
              yield* Store.markStatus(id, "terminated", "Subscription terminated by server");
              break;
          }
        }),
      ),
      Effect.as(1000),
    );
    const result = yield* (row.delivery_mode === "poll" ? poll : push).pipe(Effect.result);
    if (terminated || !(yield* enabled)) return;
    if (result._tag === "Failure") {
      const error = result.failure;
      if (isRpcError(error) && (error.code === -32023 || error.code === -32024)) {
        yield* Store.markStatus(id, "terminated", rpcMessage(error));
        return;
      }
      yield* Store.markStatus(id, "failing", rpcMessage(error));
    }
    if (row.delivery_mode === "push" && result._tag === "Failure") {
      const modes = yield* deliveryModes(subscription.server, row.name).pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );
      if (modes.includes("poll")) {
        yield* Store.setDeliveryMode(id, "poll");
        continue;
      }
    }
    yield* Effect.sleep(result._tag === "Success" ? result.success : 30_000);
  }
});
