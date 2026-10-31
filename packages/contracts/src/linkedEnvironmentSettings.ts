import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const LinkedEnvironmentServerSettingsFields = {
  linkedEnvironmentsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  loadBalancingIncludeLinkedEnvironments: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
};

export const LinkedEnvironmentServerSettingsPatchFields = {
  linkedEnvironmentsEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingIncludeLinkedEnvironments: Schema.optionalKey(Schema.Boolean),
};
