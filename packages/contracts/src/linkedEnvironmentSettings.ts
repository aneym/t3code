import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Weights = Schema.Record(
  Schema.String,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);

export const LinkedEnvironmentServerSettingsFields = {
  agentLoadBalancingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  agentLoadBalancingWeights: Weights.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  linkedEnvironmentsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  loadBalancingIncludeLinkedEnvironments: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
};

export const LinkedEnvironmentServerSettingsPatchFields = {
  agentLoadBalancingEnabled: Schema.optionalKey(Schema.Boolean),
  agentLoadBalancingWeights: Schema.optionalKey(Weights),
  linkedEnvironmentsEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingIncludeLinkedEnvironments: Schema.optionalKey(Schema.Boolean),
};
