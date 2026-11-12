import {
  CommandId,
  type MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { EventSinkV2Shape } from "./EventSink.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import { OrchestratorDispatchError } from "./OrchestratorDispatchError.ts";

const COMMAND_PREFIX = "server:snooze-after-queue:";

export const queueDrainSnoozeCommandId = (commandId: CommandId, attempt: number) =>
  CommandId.make(`${COMMAND_PREFIX}${commandId}:${attempt}`);

const isDispatchError = Schema.is(OrchestratorDispatchError);

export const isQueuedRunRefusal = (error: unknown) =>
  isDispatchError(error) && error.reason === "thread_has_queued_run";

export type QueueDrainSnooze = NonNullable<
  Extract<OrchestrationV2Command, { readonly type: "thread.snooze" }>["whenQueueDrains"]
>;

export interface QueueDrainSnoozeStores {
  readonly eventSink: Pick<EventSinkV2Shape, "read">;
  readonly projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">;
}

const ORGANIZE_EVENT_TYPES = [
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.settled",
  "thread.unsettled",
  "thread.pinned",
  "thread.unpinned",
  "thread.archived",
  "thread.unarchived",
] as const;

const organizedByOthers = (stored: OrchestrationV2StoredEvent) =>
  !stored.commandId?.startsWith(COMMAND_PREFIX);

const sentUserMessages = (stores: QueueDrainSnoozeStores, threadId: ThreadId) =>
  stores.projectionStore
    .getThreadRecords(threadId, ["messages"], { turnItemTypes: [], messageRoles: ["user"] })
    .pipe(
      Effect.map(({ messages }) =>
        messages.filter(
          (message) =>
            message.notification === undefined && message.delegatedCompletion === undefined,
        ),
      ),
    );

const idsCreatedAt = (
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  requestedMs: number,
) =>
  new Set(
    messages
      .filter((message) => DateTime.toEpochMillis(message.createdAt) === requestedMs)
      .map((message) => message.id),
  );

const idsSeenThrough = (
  stores: QueueDrainSnoozeStores,
  threadId: ThreadId,
  throughSequence: number,
  ids: ReadonlySet<MessageId>,
) =>
  ids.size === 0
    ? Effect.succeed(new Set<MessageId>())
    : stores.eventSink
        .read({ threadId, afterSequence: 0, throughSequence, eventType: "message.updated" })
        .pipe(
          Stream.runFold(
            () => new Set<MessageId>(),
            (seen, stored) =>
              stored.event.type === "message.updated" && ids.has(stored.event.payload.id)
                ? seen.add(stored.event.payload.id)
                : seen,
          ),
        );

export const captureQueueDrainSnooze = Effect.fn("QueueDrainSnooze.capture")(function* (
  stores: QueueDrainSnoozeStores,
  threadId: ThreadId,
  request: { readonly afterSequence: number; readonly requestedAt: string },
) {
  const tied = idsCreatedAt(
    yield* sentUserMessages(stores, threadId),
    Date.parse(request.requestedAt),
  );
  const seen = yield* idsSeenThrough(stores, threadId, request.afterSequence, tied);
  return { ...request, tiedMessageIds: [...seen] } satisfies QueueDrainSnooze;
});

export const queueDrainSnoozeSuperseded = Effect.fn("QueueDrainSnooze.superseded")(function* (
  stores: QueueDrainSnoozeStores,
  threadId: ThreadId,
  snooze: QueueDrainSnooze,
) {
  const requestedMs = Date.parse(snooze.requestedAt);
  const messages = yield* sentUserMessages(stores, threadId);
  if (messages.some((message) => DateTime.toEpochMillis(message.createdAt) > requestedMs)) {
    return true;
  }
  const tied = idsCreatedAt(messages, requestedMs);
  const seen =
    snooze.tiedMessageIds === undefined
      ? yield* idsSeenThrough(stores, threadId, snooze.afterSequence, tied)
      : new Set(snooze.tiedMessageIds);
  if ([...tied].some((id) => !seen.has(id))) return true;
  const organized = yield* Stream.mergeAll(
    ORGANIZE_EVENT_TYPES.map((eventType) =>
      stores.eventSink.read({ threadId, afterSequence: snooze.afterSequence, eventType }),
    ),
    { concurrency: 1 },
  ).pipe(Stream.filter(organizedByOthers), Stream.runHead);
  return Option.isSome(organized);
});

export const untilQueueDrainSnoozeOrganized = <E>(
  streamFrom: (input: {
    readonly threadId: ThreadId;
    readonly afterSequence: number;
    readonly eventType: OrchestrationV2DomainEvent["type"];
  }) => Stream.Stream<OrchestrationV2StoredEvent, E>,
  threadId: ThreadId,
  afterSequence: number,
) =>
  Stream.mergeAll(
    ORGANIZE_EVENT_TYPES.map((eventType) => streamFrom({ threadId, afterSequence, eventType })),
    { concurrency: "unbounded" },
  ).pipe(
    Stream.filter(organizedByOthers),
    Stream.runHead,
    Effect.flatMap((found) => (Option.isSome(found) ? Effect.void : Effect.never)),
    Effect.catch(() => Effect.never),
  );

export const withDeferredSnoozeCommand = (
  commands: ReadonlyMap<CommandId, ThreadId>,
  commandId: CommandId,
  threadId: ThreadId,
) => {
  const next = new Map(commands).set(commandId, threadId);
  for (const [oldest] of next) {
    if (next.size <= 1000) break;
    next.delete(oldest);
  }
  return next;
};

export const withoutLatestDeferredSnooze = (
  latest: Map<ThreadId, CommandId>,
  threadId: ThreadId,
  commandId: CommandId,
) => {
  if (latest.get(threadId) !== commandId) return latest;
  const next = new Map(latest);
  next.delete(threadId);
  return next;
};
