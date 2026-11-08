import {
  WS_METHODS,
  type ServerImportRestartHandoffInput,
  type ServerPrepareRestartInput,
  type ServerSetDrainInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderRuntimeRecoveryService from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ServerDrain from "./orchestration-v2/ServerDrain.ts";

export const makeServerRestartRpcHandlers = Effect.gen(function* () {
  const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
  const drain = yield* ServerDrain.ServerDrain;
  return {
    [WS_METHODS.serverGetRestartStatus]: ({ epoch }: ServerPrepareRestartInput) =>
      recovery.getRestartStatus(epoch),
    [WS_METHODS.serverAbortRestart]: ({ epoch }: ServerPrepareRestartInput) =>
      recovery.abortRestart(epoch),
    [WS_METHODS.serverImportRestartHandoff]: (input: ServerImportRestartHandoffInput) =>
      recovery.importRestartHandoff(input),
    [WS_METHODS.serverPrepareRestart]: (input: ServerPrepareRestartInput) =>
      recovery.prepareRestart(input.epoch, input.drainTimeoutMs),
    [WS_METHODS.serverSetDrain]: ({ draining }: ServerSetDrainInput) => drain.set(draining),
    [WS_METHODS.serverGetDrainStatus]: () => drain.status,
  };
});
