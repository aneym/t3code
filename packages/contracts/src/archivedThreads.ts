import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { OrchestratorMcpEnvironmentTarget } from "./orchestratorMcp.ts";

export const ArchivedThreadVerdict = Schema.Literals(["due", "not-due", "kept", "trimmed"]);
export type ArchivedThreadVerdict = typeof ArchivedThreadVerdict.Type;

export const ArchivedThreadKeptReason = Schema.Literals([
  "running",
  "queued",
  "pending-effect",
  "delegated-child",
  "scheduled-task",
  "pinned",
  "snoozed",
  "fork-source",
]);
export type ArchivedThreadKeptReason = typeof ArchivedThreadKeptReason.Type;

const RetentionDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 }));

export const ArchivedThreadsListInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  olderThanDays: Schema.optionalKey(RetentionDays),
  projectId: Schema.optionalKey(ProjectId),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ArchivedThreadsListInput = typeof ArchivedThreadsListInput.Type;

export const ArchivedThreadEntry = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  archivedAt: IsoDateTime,
  archivedDays: NonNegativeInt,
  items: NonNegativeInt,
  messages: NonNegativeInt,
  bytes: NonNegativeInt,
  trimmableItems: NonNegativeInt,
  trimmableBytes: NonNegativeInt,
  structureBytes: NonNegativeInt,
  historyTrimmedAt: Schema.NullOr(IsoDateTime),
  verdict: ArchivedThreadVerdict,
  keptReason: Schema.NullOr(ArchivedThreadKeptReason),
});
export type ArchivedThreadEntry = typeof ArchivedThreadEntry.Type;

export const ArchivedHistoryTrimRun = Schema.Struct({
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  retentionDays: RetentionDays,
  threadsTrimmed: NonNegativeInt,
  itemsRemoved: NonNegativeInt,
  messagesRemoved: NonNegativeInt,
  bytesRemoved: NonNegativeInt,
  kept: Schema.Record(Schema.String, NonNegativeInt),
  stoppedBy: Schema.Literals(["done", "cap", "error"]),
  statements: Schema.optional(
    Schema.Struct({
      count: NonNegativeInt,
      p95Ms: Schema.Finite,
      maxMs: Schema.Finite,
      finalPageRows: NonNegativeInt,
      finalPageBytes: NonNegativeInt,
    }),
  ),
});
export type ArchivedHistoryTrimRun = typeof ArchivedHistoryTrimRun.Type;

export const ArchivedThreadsTotals = Schema.Struct({
  threads: NonNegativeInt,
  bytes: NonNegativeInt,
  dueThreads: NonNegativeInt,
  dueBytes: NonNegativeInt,
  keptThreads: NonNegativeInt,
  trimmedThreads: NonNegativeInt,
  structureBytes: NonNegativeInt,
});
export type ArchivedThreadsTotals = typeof ArchivedThreadsTotals.Type;

export const ArchivedThreadsListResult = Schema.Struct({
  generatedAt: IsoDateTime,
  retentionDays: Schema.NullOr(RetentionDays),
  evaluatedDays: Schema.NullOr(RetentionDays),
  database: Schema.Struct({
    bytes: NonNegativeInt,
    freeBytes: NonNegativeInt,
    incrementalVacuum: Schema.Boolean,
  }),
  lastRun: Schema.NullOr(ArchivedHistoryTrimRun),
  totals: ArchivedThreadsTotals,
  threads: Schema.Array(ArchivedThreadEntry),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ArchivedThreadsListResult = typeof ArchivedThreadsListResult.Type;
