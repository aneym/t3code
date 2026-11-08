import * as Schema from "effect/Schema";
import { EnvironmentId, NonNegativeInt } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import type { HostResourcesSnapshot } from "./resourceTelemetry.ts";

export const AgentPlacementHealthLine = Schema.Struct({
  maxLoadPerCore: Schema.Finite.check(Schema.isGreaterThan(0)),
  minAvailableMemoryRatio: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  minFreeDiskBytes: NonNegativeInt,
});
export type AgentPlacementHealthLine = typeof AgentPlacementHealthLine.Type;

export const DEFAULT_AGENT_PLACEMENT_HEALTH_LINE: AgentPlacementHealthLine = {
  maxLoadPerCore: 2,
  minAvailableMemoryRatio: 0.05,
  minFreeDiskBytes: 10 * 1024 * 1024 * 1024,
};

export const AgentPlacementScore = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  weight: Schema.Finite,
  score: Schema.Finite,
  loadPerCore: Schema.NullOr(Schema.Finite),
  availableMemoryRatio: Schema.NullOr(Schema.Finite),
  freeDiskBytes: Schema.NullOr(Schema.Finite),
  skipped: Schema.optionalKey(Schema.String),
});
export type AgentPlacementScore = typeof AgentPlacementScore.Type;

export const AgentPlacementReceipt = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  reason: Schema.String,
  mode: Schema.optionalKey(Schema.Literals(["auto", "pinned", "local"])),
  decidedAt: Schema.optionalKey(Schema.Finite),
  scores: Schema.optionalKey(Schema.Array(AgentPlacementScore)),
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

const GIB = 1024 * 1024 * 1024;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

export function scoreAgentPlacement(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly resources: HostResourcesSnapshot | null | undefined;
  readonly weight: number;
  readonly line: AgentPlacementHealthLine;
  readonly now: number;
}): AgentPlacementScore {
  const { resources, weight, line } = input;
  const loadPerCore =
    resources == null || resources.cpuCount <= 0
      ? null
      : resources.loadAverage1m !== undefined
        ? resources.loadAverage1m / resources.cpuCount
        : resources.cpuUtilization;
  const availableMemoryRatio =
    resources == null || resources.totalMemoryBytes <= 0
      ? null
      : resources.availableMemoryBytes / resources.totalMemoryBytes;
  const freeDiskBytes = resources?.freeDiskBytes ?? null;
  const base = {
    environmentId: input.environmentId,
    label: input.label,
    weight,
    loadPerCore,
    availableMemoryRatio,
    freeDiskBytes,
  };
  const skip = (skipped: string): AgentPlacementScore => ({ ...base, score: 0, skipped });
  if (!Number.isFinite(weight) || weight <= 0) return skip("Weight is 0.");
  if (resources == null) return skip("No host resources reported.");
  if (input.now - resources.sampledAt > 15_000 || resources.sampledAt > input.now + 5_000)
    return skip("Host resources are stale.");
  if (loadPerCore === null || availableMemoryRatio === null)
    return skip("No CPU or memory reading.");
  if (loadPerCore > line.maxLoadPerCore)
    return skip(
      `Load per core ${loadPerCore.toFixed(2)} is over the health line ${line.maxLoadPerCore}.`,
    );
  if (availableMemoryRatio < line.minAvailableMemoryRatio)
    return skip(
      `Available memory ${percent(availableMemoryRatio)} is under the health line ${percent(line.minAvailableMemoryRatio)}.`,
    );
  if (freeDiskBytes !== null && freeDiskBytes < line.minFreeDiskBytes)
    return skip(
      `Free disk ${(freeDiskBytes / GIB).toFixed(1)} GiB is under the health line ${(line.minFreeDiskBytes / GIB).toFixed(1)} GiB.`,
    );
  const diskRatio =
    freeDiskBytes !== null && resources.totalDiskBytes !== undefined && resources.totalDiskBytes > 0
      ? freeDiskBytes / resources.totalDiskBytes
      : 1;
  const freeCores = resources.cpuCount * Math.max(0, 1 - loadPerCore / line.maxLoadPerCore);
  return { ...base, score: weight * freeCores * availableMemoryRatio * diskRatio };
}
