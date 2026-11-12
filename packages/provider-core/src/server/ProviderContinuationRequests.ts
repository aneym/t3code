import {
  type OrchestrationV2Notification,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import * as ProviderWakeDispatches from "./ProviderWakeDispatches.ts";

export interface ProviderContinuationRequest {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly detail: string | null;
  readonly notification?: OrchestrationV2Notification;
  readonly delegatedCompletion?: {
    readonly parentRunId: RunId;
    readonly generation: number;
    readonly messageId: MessageId;
  };
  /** adapter_buffered (default) ingests existing CLI output; message_text delivers app-owned wake text. */
  readonly delivery?: "adapter_buffered" | "message_text";
  readonly messageId?: MessageId;
  readonly dispatchIfCurrent?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly clearIfCurrent?: () => Effect.Effect<void>;
  /** Called when the run this request dispatched ends without starting, such as a cancelled queued run. */
  readonly onRunEndedWithoutStarting?: () => Effect.Effect<void>;
}

/** The default drops requests; share the live layer with the worker that drains them. */
export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

export const isProviderStartedTurn = (request: ProviderContinuationRequest) =>
  (request.delivery ?? "adapter_buffered") === "adapter_buffered" &&
  request.delegatedCompletion === undefined;

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    const wakes = yield* ProviderWakeDispatches.make;
    return Context.make(ProviderContinuationRequests, {
      offer: Effect.fn("ProviderContinuationRequests.offer")(function* (
        request: ProviderContinuationRequest,
      ) {
        if (isProviderStartedTurn(request)) yield* wakes.track(request.threadId);
        yield* Queue.offer(queue, request);
      }),
      take: Queue.take(queue),
    }).pipe(Context.add(ProviderWakeDispatches.ProviderWakeDispatches, wakes));
  }),
);
