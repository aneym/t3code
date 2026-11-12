import {
  latestProviderTurnForAttempt,
  type OrchestrationV2Run,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { OrchestratorDispatchError } from "./OrchestratorDispatchError.ts";

export const secretOwnerChain = (runs: ReadonlyArray<OrchestrationV2Run>, runId: RunId) => {
  const chain = new Set<RunId>();
  let current = runs.find((run) => run.id === runId);
  while (current !== undefined && !chain.has(current.id)) {
    chain.add(current.id);
    current = runs.find((run) => run.id === current?.restartContinuationOfRunId);
  }
  return chain;
};

export const decideSecretRequestRecord = Effect.fn("orchestrationV2.decideSecretRequestRecord")(
  function* (
    command: Extract<OrchestrationV2InternalCommand, { readonly type: "secret_request.record" }>,
    projection: Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "turnItems" | "providerTurns" | "attempts"
    >,
    ordinal: number,
  ) {
    const run = projection.runs.find((candidate) => candidate.id === command.runId);
    if (run === undefined || run.rootNodeId !== command.nodeId) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Node ${command.nodeId} is not the root of run ${command.runId}.`,
      });
    }
    const existing = projection.turnItems.find((item) => item.id === command.turnItemId);
    if (existing !== undefined && existing.type !== "secret_request") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Turn item ${command.turnItemId} is not a secret request.`,
      });
    }
    const rebind =
      existing !== undefined &&
      existing.runId !== null &&
      existing.runId !== run.id &&
      existing.secretStatus === "pending" &&
      command.secretStatus === "pending" &&
      secretOwnerChain(projection.runs, run.id).has(existing.runId);
    if (existing !== undefined && existing.runId !== command.runId && !rebind) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Secret request ${command.turnItemId} belongs to another run.`,
      });
    }
    const now = yield* DateTime.now;
    const unchanged =
      existing !== undefined &&
      !rebind &&
      (existing.secretStatus !== "pending" || command.secretStatus === "pending");
    const pending = command.secretStatus === "pending";
    const providerTurn =
      run.activeAttemptId === null
        ? undefined
        : (latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId) ??
          projection.providerTurns.find(
            (turn) =>
              projection.attempts.find((attempt) => attempt.id === run.activeAttemptId)
                ?.providerTurnId === turn.id,
          ));
    const turnItem: OrchestrationV2TurnItem = unchanged
      ? existing
      : {
          id: command.turnItemId,
          threadId: command.threadId,
          runId: command.runId,
          nodeId: command.nodeId,
          providerThreadId: run.providerThreadId,
          providerTurnId: providerTurn?.id ?? null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: existing?.ordinal ?? ordinal,
          status: pending
            ? "waiting"
            : command.secretStatus === "saved"
              ? "completed"
              : "cancelled",
          title: command.label,
          startedAt: existing?.startedAt ?? now,
          completedAt: pending ? null : now,
          updatedAt: now,
          type: "secret_request",
          label: command.label,
          reason: command.reason,
          ...(command.placeholder === undefined ? {} : { placeholder: command.placeholder }),
          ...(command.delivery === undefined ? {} : { delivery: command.delivery }),
          secretStatus: command.secretStatus,
        };
    return {
      type: "turn-item.updated" as const,
      threadId: command.threadId,
      runId: command.runId,
      nodeId: command.nodeId,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: turnItem,
    };
  },
);
