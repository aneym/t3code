import type {
  OrchestrationV2AppThread,
  OrchestrationV2ProviderTurn,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";

type ProviderEvent = ProviderAdapter.ProviderAdapterV2Event;
type ProviderEventFilter = ReturnType<typeof makeAssistantStreamingFilter>;

const PROVIDER_TURN_REFRESH_MS = 10_000;

export interface HeadlessThreadStreamingShape {
  readonly watch: <A, E, R>(
    threadId: ThreadId,
    stream: Stream.Stream<A, E, R>,
  ) => Stream.Stream<A, E, R>;
  readonly makeFilter: (
    thread: OrchestrationV2AppThread,
  ) => Effect.Effect<ProviderEventFilter, ServerSettingsError>;
}

export class HeadlessThreadStreaming extends Context.Service<
  HeadlessThreadStreaming,
  HeadlessThreadStreamingShape
>()("t3/orchestration-v2/HeadlessThreadStreaming") {}

const eventThreadId = (event: ProviderEvent): ThreadId | undefined =>
  event.type === "turn_item.updated"
    ? event.turnItem.threadId
    : event.type === "message.updated"
      ? event.message.threadId
      : event.type === "node.updated"
        ? event.node.threadId
        : "threadId" in event
          ? event.threadId
          : undefined;

const providerTurnShape = (turn: OrchestrationV2ProviderTurn) =>
  [
    turn.status,
    turn.nativeTurnRef?.nativeId,
    turn.startedAt?.epochMilliseconds,
    turn.completedAt?.epochMilliseconds,
    turn.permissionDenials?.length,
  ].join("|");

export const layer = Layer.effect(
  HeadlessThreadStreaming,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const viewers = new Map<ThreadId, number>();
    const watched = (threadId: ThreadId | undefined) =>
      threadId !== undefined && viewers.has(threadId);

    const watch: HeadlessThreadStreamingShape["watch"] = (threadId, stream) =>
      Stream.suspend(() => {
        viewers.set(threadId, (viewers.get(threadId) ?? 0) + 1);
        return stream.pipe(
          Stream.ensuring(
            Effect.sync(() => {
              const remaining = (viewers.get(threadId) ?? 1) - 1;
              if (remaining > 0) viewers.set(threadId, remaining);
              else viewers.delete(threadId);
            }),
          ),
        );
      });

    const makeFilter: HeadlessThreadStreamingShape["makeFilter"] = Effect.fn(
      "HeadlessThreadStreaming.makeFilter",
    )(function* (thread) {
      const settings = yield* serverSettings.getSettings;
      const mode = resolveProjectSettings(settings, thread.projectId).settings
        .responseStreamingMode;
      if (
        !settings.headlessSubagentStreaming ||
        thread.lineage.relationshipToParent !== "subagent" ||
        thread.pinnedAt != null
      )
        return makeAssistantStreamingFilter(mode);
      const live = (event: ProviderEvent) => watched(thread.id) || watched(eventThreadId(event));
      const assistant = makeAssistantStreamingFilter((event) => (live(event) ? mode : "turn"));
      const storedTurns = new Map<string, { readonly shape: string; readonly at: number }>();
      const filter: ProviderEventFilter["filter"] = (event, now) => {
        if (event.type !== "provider_turn.updated") return assistant.filter(event, now);
        const turn = event.providerTurn;
        const shape = providerTurnShape(turn);
        const stored = storedTurns.get(turn.id);
        if (
          stored !== undefined &&
          stored.shape === shape &&
          now - stored.at < PROVIDER_TURN_REFRESH_MS &&
          !live(event)
        )
          return null;
        storedTurns.set(turn.id, { shape, at: now });
        return event;
      };
      return { ...assistant, filter };
    });

    return HeadlessThreadStreaming.of({ watch, makeFilter });
  }),
);
