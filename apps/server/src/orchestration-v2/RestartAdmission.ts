import type { OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { EffectOutboxV2Shape } from "./EffectOutbox.ts";

type RestartAdmission = "open" | "draining" | "prepared";
type DispatchMode = Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"];

export const restartAdmission = Effect.fn("RestartAdmission.snapshot")(function* (
  outbox: Pick<EffectOutboxV2Shape, "restartPrepared" | "restartDraining">,
): Effect.fn.Return<RestartAdmission> {
  if ((yield* outbox.restartPrepared) !== undefined) return "prepared";
  return (yield* outbox.restartDraining) === undefined ? "open" : "draining";
});

export const admittedDispatchMode = (
  mode: DispatchMode,
  admission: RestartAdmission,
): DispatchMode =>
  admission === "prepared" ||
  (admission === "draining" && (mode.type === "start_immediately" || mode.type === "defer_start"))
    ? { type: "queue_after_active" }
    : mode;
