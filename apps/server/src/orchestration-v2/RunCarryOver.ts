import {
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  orchestrationV2RunWorkStartedAt,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

interface Continuation {
  readonly restartContinuationOfRunId?: RunId | undefined;
  readonly usageLimitContinuationOfRunId?: RunId | undefined;
  readonly manualContinuationOfRunId?: RunId | undefined;
}

export const continuedChildLight = (
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "childLight">>,
  command: Continuation,
): { readonly childLight?: true } => {
  const source =
    command.restartContinuationOfRunId ??
    command.usageLimitContinuationOfRunId ??
    command.manualContinuationOfRunId;
  return source !== undefined && runs.some((run) => run.id === source && run.childLight === true)
    ? { childLight: true }
    : {};
};

export const wakeWorkStartedAt = (
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents">,
  trigger: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "senderThreadId"
  > & {
    readonly notification?: unknown;
    readonly delegatedCompletion?: unknown;
    readonly restartContinuationOfRunId?: RunId | undefined;
  },
  delivery: "immediate" | "automatic-queue" | "explicit-queue" = "immediate",
): Pick<OrchestrationV2Run, "workStartedAt"> => {
  if (
    trigger.notification === undefined &&
    trigger.delegatedCompletion === undefined &&
    trigger.restartContinuationOfRunId === undefined &&
    !(
      trigger.createdBy === "agent" &&
      trigger.creationSource === "mcp" &&
      trigger.senderThreadId !== undefined &&
      (delivery === "automatic-queue" ||
        (delivery === "immediate" &&
          projection.subagents.some(
            (subagent) =>
              subagent.origin === "app_owned" && subagent.childThreadId === trigger.senderThreadId,
          )))
    )
  ) {
    return {};
  }
  const previous = projection.runs
    .flatMap((run) => (run.startedAt === null ? [] : [{ run, startedAt: run.startedAt }]))
    .toSorted(
      (left, right) =>
        DateTime.Order(right.startedAt, left.startedAt) || right.run.ordinal - left.run.ordinal,
    )[0]?.run;
  return previous === undefined ? {} : { workStartedAt: orchestrationV2RunWorkStartedAt(previous) };
};
