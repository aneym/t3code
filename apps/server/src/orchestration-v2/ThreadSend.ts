import {
  type ChatAttachment,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ProviderSessionId,
  type ScheduledTaskId,
  type ThreadSendDelivery,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as Orchestrator from "./Orchestrator.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
} from "./ProjectionStore.ts";

type ThreadSendMode = "auto" | "queue" | "steer" | "restart";

export interface ThreadSendInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly mode: ThreadSendMode;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadSendResult extends ThreadSendDelivery {
  readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "turnItems"
  >;
  readonly message: OrchestrationV2ConversationMessage;
  readonly run: OrchestrationV2Run;
  readonly turnItem: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> | null;
}

export class ThreadManagementThreadArchivedError extends Schema.TaggedError<ThreadManagementThreadArchivedError>()(
  "ThreadManagementThreadArchivedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is archived and cannot receive messages.`;
  }
}

export class ThreadManagementNoSteerableRunError extends Schema.TaggedError<ThreadManagementNoSteerableRunError>()(
  "ThreadManagementNoSteerableRunError",
  {
    threadId: ThreadId,
    mode: Schema.Literals(["steer", "restart"]),
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no running turn that can be ${this.mode === "steer" ? "steered" : "restarted"}.`;
  }
}

export class ThreadManagementDurableRunProjectionError extends Schema.TaggedError<ThreadManagementDurableRunProjectionError>()(
  "ThreadManagementDurableRunProjectionError",
  {
    threadId: ThreadId,
    messageId: MessageId,
  },
) {
  override get message(): string {
    return `Message ${this.messageId} was accepted on thread ${this.threadId} without a durable run projection.`;
  }
}

export class ThreadManagementSendConflictError extends Schema.TaggedError<ThreadManagementSendConflictError>()(
  "ThreadManagementSendConflictError",
  {
    threadId: ThreadId,
    commandId: CommandId,
  },
) {
  override get message(): string {
    return `Request ${this.commandId} was already used for a different send to thread ${this.threadId}, or that send was rejected.`;
  }
}

type SendDispatchMode = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>["dispatchMode"];

type SendTarget = Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">;

function latestSteerableRun(projection: SendTarget): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(
      (run) =>
        run.status === "running" &&
        run.activeAttemptId !== null &&
        projection.providerTurns.some(
          (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
        ),
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

interface ThreadSendDeps<LoadError, DispatchError> {
  readonly loadRecords: <K extends ProjectionRecordField>(
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, LoadError>;
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<Orchestrator.OrchestratorV2DispatchResult, DispatchError>;
  readonly latestActiveRun: (
    projection: Pick<OrchestrationV2ThreadProjection, "runs">,
  ) => OrchestrationV2Run | undefined;
  readonly sessionIsLive: (providerSessionId: ProviderSessionId) => Effect.Effect<boolean>;
  readonly hasReceipt: (commandId: CommandId) => Effect.Effect<boolean>;
}

export const makeSendToThread = <LoadError, DispatchError>(
  deps: ThreadSendDeps<LoadError, DispatchError>,
) => {
  const replayDispatchMode = (input: ThreadSendInput): SendDispatchMode => ({
    type: input.mode === "queue" ? "queue_after_active" : "start_immediately",
  });

  const unacceptedRun = Effect.fn("ThreadSend.unacceptedRun")(function* (
    input: ThreadSendInput,
    target: SendTarget & Pick<OrchestrationV2ThreadProjection, "providerThreads">,
  ) {
    if (input.mode === "queue") return undefined;
    const active = deps.latestActiveRun(target);
    if (
      active === undefined ||
      !(
        active.status === "running" ||
        (active.status === "starting" && (input.mode === "restart" || input.mode === "steer"))
      )
    ) {
      return undefined;
    }
    const providerThread = target.providerThreads.find(
      (thread) => thread.id === active.providerThreadId,
    );
    const turnRunning = target.providerTurns.some(
      (turn) => turn.runAttemptId === active.activeAttemptId && turn.status === "running",
    );
    const sessionLost =
      providerThread?.providerSessionId == null ||
      !(yield* deps.sessionIsLive(providerThread.providerSessionId));
    return sessionLost || !turnRunning ? active : undefined;
  });

  const resolveDispatchMode = Effect.fn("ThreadSend.resolveDispatchMode")(function* (
    input: ThreadSendInput,
    loaded: SendTarget & Pick<OrchestrationV2ThreadProjection, "providerThreads">,
  ) {
    let target = loaded;
    let recoveredUnacceptedRun = false;
    const stuck = yield* unacceptedRun(input, target);
    if (stuck !== undefined) {
      target = yield* deps.loadRecords(input, ["runs", "providerTurns", "providerThreads"]);
      if (yield* deps.hasReceipt(input.commandId)) return replayDispatchMode(input);
      if ((yield* unacceptedRun(input, target))?.id === stuck.id) {
        yield* deps.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`${input.commandId}:interrupt-unaccepted-run:${stuck.id}`),
          threadId: input.threadId,
          runId: stuck.id,
          reason: "Replaced a run whose provider turn never started.",
        });
        recoveredUnacceptedRun = true;
        target = yield* deps.loadRecords(input, ["runs", "providerTurns", "providerThreads"]);
      }
    }
    const steerableRun = latestSteerableRun(target);
    if ((input.mode === "steer" || input.mode === "restart") && !recoveredUnacceptedRun) {
      if (steerableRun === undefined) {
        return yield* new ThreadManagementNoSteerableRunError({
          threadId: input.threadId,
          mode: input.mode,
        });
      }
      return {
        type: input.mode === "steer" ? "steer_active" : "restart_active",
        targetRunId: steerableRun.id,
      } satisfies SendDispatchMode;
    }
    if (input.mode === "auto" && steerableRun !== undefined) {
      return { type: "steer_active", targetRunId: steerableRun.id } satisfies SendDispatchMode;
    }
    return replayDispatchMode(input);
  });

  return Effect.fn("ThreadManagementService.sendToThread")(function* (input: ThreadSendInput) {
    const conflict = () =>
      new ThreadManagementSendConflictError({
        threadId: input.threadId,
        commandId: input.commandId,
      });
    let dispatchMode: SendDispatchMode;
    if (yield* deps.hasReceipt(input.commandId)) {
      const recorded = yield* deps.loadRecords(input, ["messages"], {
        messageIds: [input.messageId],
      });
      if (!recorded.messages.some((candidate) => candidate.id === input.messageId)) {
        return yield* conflict();
      }
      dispatchMode = replayDispatchMode(input);
    } else {
      const loaded = yield* deps.loadRecords(input, ["runs", "providerTurns", "providerThreads"]);
      if (loaded.thread.archivedAt !== null) {
        return yield* new ThreadManagementThreadArchivedError({ threadId: input.threadId });
      }
      dispatchMode = yield* resolveDispatchMode(input, loaded).pipe(
        Effect.catch((error) =>
          deps
            .hasReceipt(input.commandId)
            .pipe(
              Effect.flatMap((nowAccepted) =>
                nowAccepted ? Effect.succeed(replayDispatchMode(input)) : Effect.fail(error),
              ),
            ),
        ),
      );
    }

    const dispatched = yield* deps.dispatch({
      type: "message.dispatch",
      commandId: input.commandId,
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
      ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
      text: input.text,
      attachments: input.attachments,
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      dispatchMode,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });
    const projection = yield* deps.loadRecords(input, ["runs", "messages", "turnItems"], {
      messageIds: [input.messageId],
      turnItemTypes: ["user_message"],
    });
    const message = projection.messages.find((candidate) => candidate.id === input.messageId);
    if (message === undefined && dispatched.replayed === true) return yield* conflict();
    const run =
      message?.runId === null || message?.runId === undefined
        ? undefined
        : projection.runs.find((candidate) => candidate.id === message.runId);
    const turnItem =
      projection.turnItems.find(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
          candidate.type === "user_message" && candidate.messageId === input.messageId,
      ) ?? null;
    if (
      message === undefined ||
      run === undefined ||
      (turnItem === null && run.status !== "queued" && dispatched.replayed !== true)
    ) {
      return yield* new ThreadManagementDurableRunProjectionError({
        threadId: input.threadId,
        messageId: input.messageId,
      });
    }
    const delivery: ThreadSendResult["delivery"] =
      run.status === "queued" && run.queueHeld === true
        ? "held"
        : turnItem === null || turnItem.inputIntent === "queued_turn"
          ? "queued"
          : turnItem.inputIntent === "turn_start"
            ? "started"
            : input.mode === "restart"
              ? "restarted"
              : "steered";
    return {
      dispatch: dispatched,
      projection,
      message,
      run,
      turnItem,
      delivery,
      ...(delivery === "held"
        ? {
            holdReason: run.queueHoldReason ?? null,
            next: 'Use mode "auto" to run a message without waiting on the held queue, or explicitly resume the queue.',
          }
        : {}),
    };
  });
};
