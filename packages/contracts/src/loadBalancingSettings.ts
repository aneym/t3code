import type { HostResourcesSnapshot } from "./resourceTelemetry.ts";
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

export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    environmentId: string;
    resources: HostResourcesSnapshot | null;
    receivedAt?: number;
    weight: number;
  }>,
  now: number,
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      now - sampledAt > 15_000 ||
      sampledAt > now + 5_000 ||
      resources.cpuUtilization === null ||
      resources.cpuUtilization >= 0.95 ||
      resources.totalMemoryBytes <= 0 ||
      resources.cpuCount <= 0
    ) {
      continue;
    }
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes;
    if (memoryAvailable <= 0.05) continue;
    const score = weight * resources.cpuCount * (1 - resources.cpuUtilization) * memoryAvailable;
    if (score > bestScore) {
      selected = environmentId;
      bestScore = score;
    }
  }
  return selected;
}
