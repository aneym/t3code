import type {
  OrchestrationV2StoredEvent,
  OrchestratorMcpDelegateTaskInput,
} from "@t3tools/contracts";

export const completionWakeFor = (input: OrchestratorMcpDelegateTaskInput, held: boolean) =>
  input.mode === "wait" && !held ? ("settled_only" as const) : ("always" as const);

export const delegatedAdmission = (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) => {
  const taskEvent = storedEvents.find(
    ({ event }) => event.type === "subagent.updated" && event.payload.origin === "app_owned",
  );
  if (taskEvent?.event.type !== "subagent.updated") return undefined;
  const childThreadId = taskEvent.event.payload.childThreadId;
  const childRun = storedEvents.find(
    ({ event }) => event.type === "run.created" && event.threadId === childThreadId,
  )?.event;
  return {
    taskId: taskEvent.event.payload.id,
    prepare:
      childThreadId !== null &&
      childRun?.type === "run.created" &&
      childRun.payload.workspacePreparation !== undefined
        ? { threadId: childThreadId, runId: childRun.payload.id }
        : undefined,
    held: storedEvents.some(
      ({ event }) => event.type === "run.updated" && event.payload.childStartHeld === true,
    ),
  };
};
