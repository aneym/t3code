import type {
  AgentPlacementHold,
  AgentPlacementReceipt,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Gate from "../orchestration-v2/DelegatedChildStartGate.ts";
import { heldThere } from "../peer/RemoteHolds.ts";

interface HoldableResult {
  readonly status: string;
  readonly childRunId: RunId | null;
  readonly remoteChild?: { readonly threadId: ThreadId } | undefined;
  readonly placement?: AgentPlacementReceipt | undefined;
}

export const withHold = Effect.fn("DelegatedHold.withHold")(function* <A extends HoldableResult>(
  result: A,
): Effect.fn.Return<A & { readonly hold?: AgentPlacementHold }> {
  if (result.status !== "queued" && result.status !== "preparing") return result;
  const gate = yield* Effect.serviceOption(Gate.DelegatedChildStartGate);
  const hold =
    result.remoteChild !== undefined
      ? (heldThere(result.remoteChild.threadId) ?? result.placement?.hold)
      : result.childRunId === null || Option.isNone(gate)
        ? undefined
        : yield* gate.value.hold(result.childRunId);
  if (hold === undefined) return result;
  return {
    ...result,
    hold,
    ...(result.placement === undefined ? {} : { placement: { ...result.placement, hold } }),
  };
});
