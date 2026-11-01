import * as Schema from "effect/Schema";
import { CommandId, ThreadId, IsoDateTime } from "./baseSchemas.ts";

const SettlementSource = Schema.Literals(["sweep", "user", "mcp"]);
export const ThreadSettlement = Schema.Struct({
  source: SettlementSource,
  commandId: CommandId,
  recordedAt: IsoDateTime,
});
export const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
  source: Schema.optional(SettlementSource),
  settledAt: Schema.optional(Schema.DateTimeUtc),
});
export const ThreadAutoSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.auto-settle"),
  commandId: CommandId,
  threadId: ThreadId,
  snapshotAt: Schema.DateTimeUtc,
  settledParentThreadId: Schema.optional(ThreadId),
  settledAt: Schema.optional(Schema.DateTimeUtc),
});
export const ThreadLifecycleFields = {
  lastSettlement: Schema.optional(ThreadSettlement),
  archived: Schema.Boolean,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};
