import * as Schema from "effect/Schema";
import { CommandId, ThreadId } from "./baseSchemas.ts";

export const ThreadHistoryMarkTrimmedCommand = Schema.Struct({
  type: Schema.Literal("thread.history.mark-trimmed"),
  commandId: CommandId,
  threadId: ThreadId,
  archivedAt: Schema.DateTimeUtc,
  trimmedAt: Schema.DateTimeUtc,
});
