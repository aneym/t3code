// @effect-diagnostics-next-line nodeBuiltinImport:off -- Message keys need a digest.
import * as NodeCrypto from "node:crypto";

import { CommandId, type McpEventOccurrence, MessageId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { serverLabel } from "./eventsRpc.ts";
import { deliveryText } from "./eventText.ts";
import * as Store from "./McpEventsStore.ts";

export type DeliveryOutcome = "accepted" | "duplicate" | "unavailable";

const deliveryKey = (row: Store.SubscriptionRow, event: McpEventOccurrence) =>
  `mcp-events:${row.id}:${NodeCrypto.createHash("sha256").update(event.eventId).digest("hex").slice(0, 32)}`;

export const makeDelivery = (
  threads: ThreadManagementService.ThreadManagementService["Service"],
) => {
  const dispatch = Effect.fn("McpEvents.dispatch")(function* (
    row: Store.SubscriptionRow,
    event: McpEventOccurrence,
  ) {
    const shell = yield* threads
      .getThreadShell(row.thread_id as ThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null) return false;
    const key = deliveryKey(row, event);
    const subscription = Store.toSubscription(row);
    return yield* threads
      .sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`command:${key}`),
        threadId: shell.id,
        messageId: MessageId.make(`message:${key}`),
        text: deliveryText({ subscription, event }),
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
        mcpEvent: { name: event.name, server: serverLabel(subscription.server) },
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("MCP event dispatch failed", { subscriptionId: row.id, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
  });

  return Effect.fn("McpEvents.deliverOnce")(function* (
    row: Store.SubscriptionRow,
    event: McpEventOccurrence,
  ) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const claim = yield* Store.claimDelivery(row.id, event.eventId, nowMs);
    if (claim === "dispatched") return "duplicate" satisfies DeliveryOutcome;
    if (!(yield* dispatch(row, event))) {
      if (claim === "claimed") yield* Store.releaseDelivery(row.id, event.eventId);
      return "unavailable" satisfies DeliveryOutcome;
    }
    yield* Store.markDispatched(row.id, event.eventId);
    if (claim === "pending") return "duplicate" satisfies DeliveryOutcome;
    yield* Store.recordDelivery(row.id, DateTime.formatIso(yield* DateTime.now));
    return "accepted" satisfies DeliveryOutcome;
  });
};
