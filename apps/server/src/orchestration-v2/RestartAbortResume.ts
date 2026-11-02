import { WS_METHODS, type ServerPrepareRestartInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

export const abortRestartAndResume = Effect.fn("RestartAbortResume.abortRestartAndResume")(
  function* (epoch: string) {
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const result = yield* recovery.abortRestart(epoch);
    yield* orchestrator.resumeQueuedRuns.pipe(Effect.ignore, Effect.forkDetach);
    return result;
  },
);

export const restartAbortRpc = {
  [WS_METHODS.serverAbortRestart]: ({ epoch }: ServerPrepareRestartInput) =>
    abortRestartAndResume(epoch),
};
