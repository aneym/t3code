import {
  isDelegatedAppThread,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { MAX_REPORTED_DEPTH } from "../telemetry/ProviderDimensions.ts";

export const delegationDepth = Effect.fn("delegationDepth")(function* (
  threads: Pick<ThreadManagementService.ThreadManagementService["Service"], "getThreadShell">,
  thread: Pick<OrchestrationV2ThreadShell, "lineage" | "delegatedFrom">,
) {
  let depth = 0;
  let current: typeof thread | null = thread;
  while (current !== null && isDelegatedAppThread(current) && depth < MAX_REPORTED_DEPTH) {
    depth += 1;
    const parentId: ThreadId | null =
      current.lineage.relationshipToParent === "subagent" ? current.lineage.parentThreadId : null;
    current =
      parentId === null
        ? null
        : yield* threads.getThreadShell(parentId).pipe(Effect.orElseSucceed(() => null));
  }
  return depth;
});
