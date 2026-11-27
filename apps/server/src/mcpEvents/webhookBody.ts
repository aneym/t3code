import { McpEventOccurrence } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { DeliveryOutcome } from "./eventDelivery.ts";
import * as Store from "./McpEventsStore.ts";
import { redactTokens } from "./secretText.ts";

export interface McpEventsReceipt {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const Control = Schema.Struct({
  type: Schema.String,
  challenge: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
});
const decodeControl = Schema.decodeOption(Schema.fromJsonString(Control));
const decodeOccurrence = Schema.decodeOption(Schema.fromJsonString(McpEventOccurrence));
const reply = (status: number, body: Record<string, unknown>): McpEventsReceipt => ({
  status,
  body,
});

const terminatedText = (error: (typeof Control.Type)["error"]) => {
  const message = redactTokens(error?.message?.trim() ?? "").slice(0, 160);
  const code = error?.code === undefined ? "" : ` (${error.code})`;
  return `Terminated by server${message === "" ? "" : `: ${message}`}${code}`;
};

export const handleWebhookBody = Effect.fn("McpEvents.handleWebhookBody")(function* <E, R>(input: {
  readonly row: Store.SubscriptionRow;
  readonly text: string;
  readonly webhookId: string | undefined;
  readonly deliver: (
    row: Store.SubscriptionRow,
    event: McpEventOccurrence,
  ) => Effect.Effect<DeliveryOutcome, E, R>;
}) {
  const { row, text, webhookId } = input;
  const control = Option.getOrUndefined(decodeControl(text));
  if (control?.type === "verification") {
    return control.challenge === undefined
      ? reply(400, { error: "missing_challenge" })
      : reply(200, { challenge: control.challenge });
  }
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  if (webhookId !== undefined && (yield* Store.hasWebhookReceipt(row.id, webhookId, nowMs))) {
    return reply(202, { status: "duplicate" });
  }
  const seen =
    webhookId === undefined ? Effect.void : Store.recordWebhookReceipt(row.id, webhookId, nowMs);
  if (control !== undefined) {
    if (control.type === "gap") {
      yield* Store.saveCursor(row.id, control.cursor ?? null, true);
      yield* Effect.logWarning("MCP Events server reported a gap", { subscriptionId: row.id });
    } else if (control.type === "terminated") {
      yield* Store.markStatus(row.id, "terminated", terminatedText(control.error));
      yield* Effect.logWarning("MCP Events subscription terminated by server", {
        subscriptionId: row.id,
        code: control.error?.code,
      });
    } else {
      yield* Effect.logInfo("MCP Events ignored an unknown control envelope", {
        subscriptionId: row.id,
        type: control.type.slice(0, 40),
      });
    }
    yield* seen;
    return reply(200, { ok: true });
  }
  const event = Option.getOrUndefined(decodeOccurrence(text));
  if (event === undefined) return reply(400, { error: "invalid_event" });
  if (event.name !== row.name) return reply(400, { error: "event_mismatch" });
  const outcome = yield* input.deliver(row, event);
  if (outcome === "unavailable") return reply(503, { error: "thread_unavailable" });
  if (event.cursor !== undefined) yield* Store.saveCursor(row.id, event.cursor, false);
  yield* seen;
  return reply(202, { status: outcome });
});
