import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { ServerDrainError, ServerDrainStatus, ServerSetDrainInput } from "./serverDrain.ts";
import {
  ServerAbortRestartResult,
  ServerPrepareRestartError,
  ServerPrepareRestartInput,
  ServerPrepareRestartResult,
  ServerRestartStatus,
} from "./serverRestart.ts";
import {
  ServerImportRestartHandoffError,
  ServerImportRestartHandoffInput,
} from "./serverRestartImport.ts";

export const SERVER_RESTART_WS_METHODS = {
  serverGetRestartStatus: "server.getRestartStatus",
  serverPrepareRestart: "server.prepareRestart",
  serverAbortRestart: "server.abortRestart",
  serverImportRestartHandoff: "server.importRestartHandoff",
  serverSetDrain: "server.setDrain",
  serverGetDrainStatus: "server.getDrainStatus",
} as const;

const restartError = Schema.Union([ServerPrepareRestartError, EnvironmentAuthorizationError]);
const drainError = Schema.Union([ServerDrainError, EnvironmentAuthorizationError]);

export const ServerRestartRpcs = [
  Rpc.make(SERVER_RESTART_WS_METHODS.serverPrepareRestart, {
    payload: ServerPrepareRestartInput,
    success: ServerPrepareRestartResult,
    error: restartError,
  }),
  Rpc.make(SERVER_RESTART_WS_METHODS.serverAbortRestart, {
    payload: ServerPrepareRestartInput,
    success: ServerAbortRestartResult,
    error: restartError,
  }),
  Rpc.make(SERVER_RESTART_WS_METHODS.serverGetRestartStatus, {
    payload: ServerPrepareRestartInput,
    success: ServerRestartStatus,
    error: restartError,
  }),
  Rpc.make(SERVER_RESTART_WS_METHODS.serverImportRestartHandoff, {
    payload: ServerImportRestartHandoffInput,
    success: ServerPrepareRestartResult,
    error: Schema.Union([ServerImportRestartHandoffError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(SERVER_RESTART_WS_METHODS.serverSetDrain, {
    payload: ServerSetDrainInput,
    success: ServerDrainStatus,
    error: drainError,
  }),
  Rpc.make(SERVER_RESTART_WS_METHODS.serverGetDrainStatus, {
    payload: Schema.Struct({}),
    success: ServerDrainStatus,
    error: drainError,
  }),
] as const;
