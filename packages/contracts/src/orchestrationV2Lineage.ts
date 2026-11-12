import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

export const OrchestrationV2AppThreadLineage = Schema.Struct({
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  rootThreadId: ThreadId,
  sideChat: Schema.optional(Schema.Boolean),
  askOnly: Schema.optional(Schema.Boolean),
});
export type OrchestrationV2AppThreadLineage = typeof OrchestrationV2AppThreadLineage.Type;

/** Subagents and side chats live inside their parent's view, never in thread lists. */
export const isListedThreadLineage = (lineage: OrchestrationV2AppThreadLineage): boolean =>
  lineage.relationshipToParent !== "subagent" && lineage.sideChat !== true;
