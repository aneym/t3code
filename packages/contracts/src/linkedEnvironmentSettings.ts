import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AgentPlacementHealthLine, DEFAULT_AGENT_PLACEMENT_HEALTH_LINE } from "./agentPlacement.ts";
import { EnvironmentId } from "./baseSchemas.ts";

const Weights = Schema.Record(
  Schema.String,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);

export const LinkedEnvironmentServerSettingsFields = {
  agentLoadBalancingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  agentLoadBalancingWeights: Weights.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  agentPlacementPinnedEnvironmentId: Schema.NullOr(EnvironmentId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentPlacementHealthLine: AgentPlacementHealthLine.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_PLACEMENT_HEALTH_LINE)),
  ),
  linkedEnvironmentsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  loadBalancingIncludeLinkedEnvironments: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
};

export const LinkedEnvironmentServerSettingsPatchFields = {
  agentLoadBalancingEnabled: Schema.optionalKey(Schema.Boolean),
  agentLoadBalancingWeights: Schema.optionalKey(Weights),
  agentPlacementPinnedEnvironmentId: Schema.optionalKey(Schema.NullOr(EnvironmentId)),
  agentPlacementHealthLine: Schema.optionalKey(AgentPlacementHealthLine),
  linkedEnvironmentsEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingIncludeLinkedEnvironments: Schema.optionalKey(Schema.Boolean),
};
