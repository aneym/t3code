import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const AgentPlacementReceipt = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  reason: Schema.String,
});
export type AgentPlacementReceipt = typeof AgentPlacementReceipt.Type;

export const AgentPlacementProviders = Schema.Array(
  Schema.Struct({
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    enabled: Schema.Boolean,
    models: Schema.Array(Schema.String),
  }),
);
