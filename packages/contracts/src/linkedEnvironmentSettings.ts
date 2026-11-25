import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AgentPlacementHealthLine, DEFAULT_AGENT_PLACEMENT_HEALTH_LINE } from "./agentPlacement.ts";
import { EnvironmentId } from "./baseSchemas.ts";

const Weights = Schema.Record(
  Schema.String,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);

const HoldMinutes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 * 60 }));

export const LinkedEnvironmentServerSettingsFields = {
  agentLoadBalancingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  agentLoadBalancingWeights: Weights.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  agentPlacementPinnedEnvironmentId: Schema.NullOr(EnvironmentId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentPlacementExplicitOnly: Schema.Array(EnvironmentId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  agentPlacementHealthLine: AgentPlacementHealthLine.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_PLACEMENT_HEALTH_LINE)),
  ),
  agentPlacementByRoom: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  agentPlacementAtStart: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  agentPlacementPaused: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  agentPlacementMaxHoldMinutes: HoldMinutes.pipe(Schema.withDecodingDefault(Effect.succeed(60))),
  agentPlacementSpillWhenFull: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
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
  agentPlacementExplicitOnly: Schema.optionalKey(Schema.Array(EnvironmentId)),
  agentPlacementHealthLine: Schema.optionalKey(AgentPlacementHealthLine),
  agentPlacementByRoom: Schema.optionalKey(Schema.Boolean),
  agentPlacementAtStart: Schema.optionalKey(Schema.Boolean),
  agentPlacementPaused: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agentPlacementMaxHoldMinutes: Schema.optionalKey(HoldMinutes),
  agentPlacementSpillWhenFull: Schema.optionalKey(Schema.Boolean),
  linkedEnvironmentsEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingIncludeLinkedEnvironments: Schema.optionalKey(Schema.Boolean),
};
