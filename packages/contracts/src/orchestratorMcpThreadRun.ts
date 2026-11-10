import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, RunId } from "./baseSchemas.ts";
import {
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2RunStatus,
} from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderPermissionDenial } from "./providerPermissionDenial.ts";
import { TurnTokenUsage } from "./providerRuntime.ts";

export const OrchestratorMcpThreadRun = Schema.Struct({
  runId: RunId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  nativeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  contextUsage: Schema.optional(OrchestrationV2ProviderTurnTokenUsage),
  tokenUsage: Schema.optional(TurnTokenUsage),
  permissionDenials: Schema.optional(Schema.Array(ProviderPermissionDenial)),
});
export type OrchestratorMcpThreadRun = typeof OrchestratorMcpThreadRun.Type;
