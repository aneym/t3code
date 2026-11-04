import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId } from "./baseSchemas.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const AgentPlacementCandidate = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  weight: Schema.Number,
  score: Schema.NullOr(Schema.Number),
  reason: Schema.String,
  resources: Schema.NullOr(HostResourcesSnapshot),
});

export const AgentPlacementReceipt = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  reason: Schema.String,
  candidates: Schema.Array(AgentPlacementCandidate),
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
