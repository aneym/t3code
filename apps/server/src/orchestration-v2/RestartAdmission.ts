import type {
  OrchestrationV2Command,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { EffectOutboxV2Shape } from "./EffectOutbox.ts";
import { personSent, type Sender } from "./PersonSender.ts";
import { nextQueuedRun } from "./QueuedRunOrder.ts";

type RestartAdmission = "open" | "draining" | "prepared";
type DispatchMode = Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"];
type AdmissionOutbox = Pick<EffectOutboxV2Shape, "restartPrepared" | "restartDraining">;
const restartAdmission = Effect.fn("RestartAdmission.snapshot")(function* (
  outbox: AdmissionOutbox,
): Effect.fn.Return<RestartAdmission> {
  if ((yield* outbox.restartPrepared) !== undefined) return "prepared";
  return (yield* outbox.restartDraining) === undefined ? "open" : "draining";
});

export const dispatchAdmission = Effect.fn("RestartAdmission.dispatch")(function* (
  outbox: AdmissionOutbox,
  sender: Sender,
): Effect.fn.Return<RestartAdmission> {
  const admission = yield* restartAdmission(outbox);
  return admission === "draining" && personSent(sender) ? "open" : admission;
});

export const queueAdvanceAdmitted = Effect.fn("RestartAdmission.queueAdvance")(function* <E, R>(
  outbox: AdmissionOutbox,
  readProjection: Effect.Effect<Pick<OrchestrationV2ThreadProjection, "runs" | "messages">, E, R>,
  options?: { readonly queuedRunId?: RunId },
) {
  const admission = yield* restartAdmission(outbox);
  if (admission !== "draining") return admission === "open";
  const projection = yield* readProjection;
  const run =
    options?.queuedRunId === undefined
      ? nextQueuedRun(projection)
      : projection.runs.find((candidate) => candidate.id === options.queuedRunId);
  return personSent(projection.messages.find((message) => message.id === run?.userMessageId));
});

export const admittedDispatchMode = (
  mode: DispatchMode,
  admission: RestartAdmission,
): DispatchMode =>
  admission === "prepared" ||
  (admission === "draining" && (mode.type === "start_immediately" || mode.type === "defer_start"))
    ? { type: "queue_after_active" }
    : mode;
