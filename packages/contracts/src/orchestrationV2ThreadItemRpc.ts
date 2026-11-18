import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2TurnItem,
} from "./orchestrationV2.ts";

export const OrchestrationV2GetTurnItemInput = Schema.Struct({
  threadId: ThreadId,
  itemId: TurnItemId,
  revision: Schema.optional(Schema.String),
});
export type OrchestrationV2GetTurnItemInput = typeof OrchestrationV2GetTurnItemInput.Type;

export const OrchestrationV2GetTurnItemResult = Schema.Struct({
  item: Schema.NullOr(OrchestrationV2TurnItem),
});
export type OrchestrationV2GetTurnItemResult = typeof OrchestrationV2GetTurnItemResult.Type;

export const OrchestrationV2GetThreadHistoryPageInput = Schema.Struct({
  threadId: ThreadId,
  cursor: TrimmedNonEmptyString,
  maxBytes: Schema.optionalKey(Schema.Int),
  throughEntryId: Schema.optionalKey(TrimmedNonEmptyString),
  view: Schema.optionalKey(Schema.Literals(["conversation", "work"])),
  deferWork: Schema.optionalKey(Schema.Boolean),
  compactIds: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationV2GetThreadHistoryPageInput =
  typeof OrchestrationV2GetThreadHistoryPageInput.Type;

const ThreadItemRpcError = Schema.Union([
  OrchestrationV2GetThreadProjectionError,
  EnvironmentAuthorizationError,
]);

export const WsOrchestrationV2GetTurnItemRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
  payload: OrchestrationV2GetTurnItemInput,
  success: OrchestrationV2GetTurnItemResult,
  error: ThreadItemRpcError,
});

export const WsOrchestrationV2GetThreadHistoryPageRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getThreadHistoryPage,
  {
    payload: OrchestrationV2GetThreadHistoryPageInput,
    success: OrchestrationV2ThreadHistoryPage,
    error: ThreadItemRpcError,
  },
);
