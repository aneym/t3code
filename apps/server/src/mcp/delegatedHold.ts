import type {
  AgentPlacementHold,
  AgentPlacementReceipt,
  EnvironmentId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Gate from "../orchestration-v2/DelegatedChildStartGate.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { forgetHold, heldThere, rememberHold } from "../peer/RemoteHolds.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

interface HoldableResult {
  readonly status: string;
  readonly childRunId: RunId | null;
  readonly remoteChild?:
    | { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
    | undefined;
  readonly placement?: AgentPlacementReceipt | undefined;
}

export const withHold = Effect.fn("DelegatedHold.withHold")(function* <A extends HoldableResult>(
  result: A,
): Effect.fn.Return<A & { readonly hold?: AgentPlacementHold }> {
  const there =
    result.remoteChild === undefined ? undefined : heldThere(result.remoteChild.threadId);
  if (there !== undefined && (result.status === "running" || result.status === "queued"))
    return {
      ...result,
      status: "queued",
      hold: there,
      ...(result.placement === undefined
        ? {}
        : { placement: { ...result.placement, hold: there } }),
    };
  if (result.remoteChild !== undefined) {
    if (result.placement?.hold === undefined) return result;
    const { hold: _unheld, ...placement } = result.placement;
    return { ...result, placement };
  }
  if (result.status !== "queued" && result.status !== "preparing") return result;
  const gate = yield* Effect.serviceOption(Gate.DelegatedChildStartGate);
  const hold =
    result.childRunId === null || Option.isNone(gate)
      ? undefined
      : yield* gate.value.hold(result.childRunId);
  if (hold === undefined) return result;
  return {
    ...result,
    hold,
    ...(result.placement === undefined ? {} : { placement: { ...result.placement, hold } }),
  };
});

export const withThreadHold = Effect.fn("DelegatedHold.withThreadHold")(function* <
  A extends { readonly thread: { readonly status: string; readonly latestRunId: RunId | null } },
>(result: A): Effect.fn.Return<A & { readonly hold?: AgentPlacementHold }> {
  if (result.thread.status !== "preparing" || result.thread.latestRunId === null) return result;
  const gate = yield* Effect.serviceOption(Gate.DelegatedChildStartGate);
  if (Option.isNone(gate)) return result;
  const hold = yield* gate.value.hold(result.thread.latestRunId);
  return hold === undefined ? result : { ...result, hold };
});

export const withLiveHold = Effect.fn("DelegatedHold.withLiveHold")(function* <
  A extends HoldableResult,
>(
  result: A,
): Effect.fn.Return<
  A & { readonly hold?: AgentPlacementHold },
  never,
  McpInvocationContext.McpInvocationContext | PeerForwarding.PeerForwarding
> {
  const remote = result.remoteChild;
  if (
    remote === undefined ||
    result.status !== "running" ||
    heldThere(remote.threadId) === undefined
  )
    return yield* withHold(result);
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const read = yield* forwarding
    .call(scope, OrchestratorToolkit.tools.t3_thread_read, remote.environmentId, {
      threadId: remote.threadId,
      limit: 1,
      runLimit: 1,
    })
    .pipe(Effect.option);
  if (Option.isNone(read)) return result;
  if (read.value.hold === undefined) {
    forgetHold(remote.threadId);
    return result;
  }
  rememberHold(remote.threadId, read.value.hold);
  return yield* withHold(result);
});
