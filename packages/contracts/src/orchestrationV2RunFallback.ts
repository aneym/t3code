import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const OrchestrationV2RunFallback = Schema.Struct({
  fromProvider: ProviderInstanceId,
  fromModel: Schema.String,
  toProvider: ProviderInstanceId,
  toModel: Schema.String,
  reasonKind: Schema.Literals(["no_accounts", "limit", "outage"]),
  reason: Schema.String,
  resetsAt: Schema.NullOr(Schema.String),
  at: IsoDateTime,
});
export type OrchestrationV2RunFallback = typeof OrchestrationV2RunFallback.Type;
