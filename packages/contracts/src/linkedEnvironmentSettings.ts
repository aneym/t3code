import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const LinkedEnvironmentServerSettingsFields = {
  /**
   * Beta: links to the user's other machines, both ways. Off refuses new links, calls over links
   * and tasks on another machine; tasks already running there finish.
   */
  linkedEnvironmentsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  loadBalancingIncludeLinkedEnvironments: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
};

export const LinkedEnvironmentServerSettingsPatchFields = {
  linkedEnvironmentsEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingIncludeLinkedEnvironments: Schema.optionalKey(Schema.Boolean),
};
