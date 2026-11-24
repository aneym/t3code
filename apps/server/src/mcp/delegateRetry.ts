import { CommandId, type NodeId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { stableCommandId } from "./stableIds.ts";

export const remoteDelegateCommandId = (scope: McpInvocationScope, key: string) =>
  CommandId.make(
    `command:mcp:${encodeURIComponent(scope.requestNamespace)}:remote-delegate:${encodeURIComponent(key)}`,
  );

export const remoteDelegateTaskId = (scope: McpInvocationScope, key: string): NodeId =>
  IdAllocator.derive.delegatedTaskNode({ commandId: remoteDelegateCommandId(scope, key) });

export const delegateRetryOf = Effect.fn("DelegateRetry.of")(function* (
  scope: McpInvocationScope,
  clientRequestId: string,
) {
  const threads = Option.getOrUndefined(
    yield* Effect.serviceOption(Threads.ThreadManagementService),
  );
  const parentThreadId = scope.thread?.threadId;
  if (threads === undefined || parentThreadId === undefined) return undefined;
  const local = stableCommandId({ scope, requestKey: clientRequestId, operation: "delegate-task" });
  if (yield* threads.hasReceipt(local)) return "local" as const;
  const taskId = remoteDelegateTaskId(scope, clientRequestId);
  const { subagents } = yield* threads
    .getThreadRecords(parentThreadId, ["subagents"], { subagentIds: [taskId] })
    .pipe(Effect.orElseSucceed(() => ({ subagents: [] as const })));
  return subagents.some((task) => task.id === taskId && task.remoteChild !== undefined)
    ? ("remote" as const)
    : undefined;
});
