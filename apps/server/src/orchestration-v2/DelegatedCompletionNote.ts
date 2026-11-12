import {
  isOrchestrationV2WorkActive,
  type DelegatedTaskOutcome,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../serverSettings.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { quietNoteEvents } from "./ThreadNote.ts";
import { NOTE_CHARS } from "./ThreadNoteContext.ts";

export const withReportedOutcome = (
  task: OrchestrationV2Subagent,
  outcome: DelegatedTaskOutcome | undefined,
): OrchestrationV2Subagent => {
  const { reportedOutcome: _previous, ...rest } = task;
  return outcome === undefined ? rest : { ...rest, reportedOutcome: outcome };
};

function completionLandsAsNote(input: {
  readonly enabled: boolean;
  readonly task: OrchestrationV2Subagent;
  readonly lead: Pick<OrchestrationV2ThreadProjection, "subagents">;
  readonly childAsks: boolean;
}): boolean {
  const { task } = input;
  return (
    input.enabled &&
    !input.childAsks &&
    task.status === "completed" &&
    task.reportedOutcome === "clean" &&
    task.awaited !== true &&
    input.lead.subagents.some(
      (other) =>
        other.id !== task.id &&
        other.origin === "app_owned" &&
        other.result === null &&
        other.completionWake === "always" &&
        isOrchestrationV2WorkActive(other.status),
    )
  );
}

function completionNoteText(task: OrchestrationV2Subagent): string {
  const label = `Delegated task ${task.id}${task.title == null ? "" : ` (${task.title})`} [${task.status}, reported clean]`;
  const text = `${label}:\n${task.result ?? ""}`;
  if (text.length <= NOTE_CHARS) return text;
  const more = `\n[Cut here. Use task_status with taskId ${task.id} to read the full result.]`;
  return `${text.slice(0, NOTE_CHARS - more.length)}${more}`;
}

export const makeCompletionNotePlanner = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projectionStore = yield* ProjectionStoreV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  return Effect.fn("Orchestrator.planCompletionNote")(function* (input: {
    readonly parentProjection: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>;
    readonly updatedTask: OrchestrationV2Subagent;
    readonly now: DateTime.Utc;
  }) {
    const { childCompletionNotes } = yield* settings.getSettings.pipe(Effect.orDie);
    const task = input.updatedTask;
    const facts = {
      enabled: childCompletionNotes,
      task,
      lead: input.parentProjection,
      childAsks: false,
    };
    if (!completionLandsAsNote(facts)) return undefined;
    const childAsks =
      task.childThreadId !== null &&
      (yield* projectionStore.getThreadRecords(task.childThreadId, [
        "runtimeRequests",
      ])).runtimeRequests.some((request) => request.status === "pending");
    if (!completionLandsAsNote({ ...facts, childAsks })) return undefined;
    const threadId = input.parentProjection.thread.id;
    const messageId = yield* idAllocator.allocate.message({
      threadId,
      ordinal: (yield* projectionStore.getMessageCount(threadId)) + 1,
    });
    const ordinal = (input.parentProjection.turnItems ?? []).reduce(
      (next, item) => Math.max(next, item.ordinal + 1),
      yield* projectionStore.getNextTurnItemOrdinal(threadId),
    );
    const remote = task.remoteChild;
    const note = quietNoteEvents(
      {
        threadId,
        messageId,
        text: completionNoteText(task),
        attachments: [],
        createdBy: "system",
        creationSource: "server",
        ...(remote === undefined
          ? task.childThreadId === null
            ? {}
            : { senderThreadId: task.childThreadId }
          : {
              senderThreadId: remote.threadId,
              senderEnvironmentId: remote.environmentId,
              senderEnvironmentLabel: remote.label,
            }),
      },
      input.now,
      { id: idAllocator.derive.userTurnItem({ messageId }), ordinal },
    );
    return {
      task: {
        ...task,
        completionDelivery: { state: "delivered" as const, observedByRunId: null },
      },
      parentRun: undefined,
      message: undefined,
      offer: false,
      note,
    };
  });
});

export const awaitedOf = (value: { readonly awaited?: true | undefined }) =>
  value.awaited === true ? { awaited: true as const } : {};
