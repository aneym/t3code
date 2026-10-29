import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const LoadBalancingWeights = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);

const SeenLinkedEnvironmentIds = Schema.Array(EnvironmentId);

export const LoadBalancingClientSettingsFields = {
  loadBalancingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  loadBalancingWeights: LoadBalancingWeights.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  loadBalancingSeenLinkedEnvironmentIds: SeenLinkedEnvironmentIds.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
};

export const LoadBalancingClientSettingsPatchFields = {
  loadBalancingEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingWeights: Schema.optionalKey(LoadBalancingWeights),
  loadBalancingSeenLinkedEnvironmentIds: Schema.optionalKey(SeenLinkedEnvironmentIds),
};
