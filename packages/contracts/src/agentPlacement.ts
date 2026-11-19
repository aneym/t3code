import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentId, NonNegativeInt } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import type { HostResourcesSnapshot } from "./resourceTelemetry.ts";

export const DEFAULT_AGENT_PLACEMENT_HEALTH_LINE = {
  maxLoadPerCore: 4,
  minAvailableMemoryRatio: 0.05,
  minFreeDiskBytes: 10 * 1024 * 1024 * 1024,
  maxServerEventLoopUtilization: 0.8,
};

export const AgentPlacementHealthLine = Schema.Struct({
  maxLoadPerCore: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_PLACEMENT_HEALTH_LINE.maxLoadPerCore)),
  ),
  minAvailableMemoryRatio: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
    Schema.withDecodingDefault(
      Effect.succeed(DEFAULT_AGENT_PLACEMENT_HEALTH_LINE.minAvailableMemoryRatio),
    ),
  ),
  minFreeDiskBytes: NonNegativeInt.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(DEFAULT_AGENT_PLACEMENT_HEALTH_LINE.minFreeDiskBytes),
    ),
  ),
  maxServerEventLoopUtilization: Schema.Finite.check(
    Schema.isBetween({ minimum: 0, maximum: 1 }),
  ).pipe(
    Schema.withDecodingDefault(
      Effect.succeed(DEFAULT_AGENT_PLACEMENT_HEALTH_LINE.maxServerEventLoopUtilization),
    ),
  ),
});
export type AgentPlacementHealthLine = typeof AgentPlacementHealthLine.Type;

export const AgentPlacementRoom = Schema.Struct({
  cap: Schema.NullOr(Schema.Finite),
  active: Schema.Finite,
  held: Schema.Finite,
  free: Schema.NullOr(Schema.Finite),
  paused: Schema.optionalKey(Schema.String),
  breach: Schema.optionalKey(Schema.String),
});
export type AgentPlacementRoom = typeof AgentPlacementRoom.Type;

export const AgentPlacementHold = Schema.Struct({
  reason: Schema.String,
  position: Schema.Finite,
  since: Schema.Finite,
  until: Schema.Finite,
});
export type AgentPlacementHold = typeof AgentPlacementHold.Type;

export const AgentPlacementScore = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  weight: Schema.Finite,
  score: Schema.Finite,
  loadPerCore: Schema.NullOr(Schema.Finite),
  availableMemoryRatio: Schema.NullOr(Schema.Finite),
  freeDiskBytes: Schema.NullOr(Schema.Finite),
  skipped: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  room: Schema.optionalKey(AgentPlacementRoom),
});
export type AgentPlacementScore = typeof AgentPlacementScore.Type;

export const AgentPlacementReceipt = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  reason: Schema.String,
  mode: Schema.optionalKey(Schema.Literals(["auto", "pinned", "local"])),
  decidedAt: Schema.optionalKey(Schema.Finite),
  scores: Schema.optionalKey(Schema.Array(AgentPlacementScore)),
  hold: Schema.optionalKey(AgentPlacementHold),
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
const UNKNOWN_RATIO = 0.1;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

export function agentPlacementRoomFull(label: string, room: AgentPlacementRoom) {
  return room.cap !== null && room.free === 0
    ? `All ${room.cap} builder slots on ${label} are in use (${room.active} running, ${room.held} queued).`
    : undefined;
}

export function agentPlacementHealthBreach(
  resources: HostResourcesSnapshot,
  line: AgentPlacementHealthLine,
) {
  const loadPerCore =
    resources.cpuCount <= 0 || resources.loadAverage1m === undefined
      ? null
      : resources.loadAverage1m / resources.cpuCount;
  const availableMemoryRatio =
    resources.totalMemoryBytes <= 0
      ? null
      : resources.availableMemoryBytes / resources.totalMemoryBytes;
  const freeDiskBytes = resources.freeDiskBytes ?? null;
  if (loadPerCore !== null && loadPerCore > line.maxLoadPerCore)
    return `Load per core ${loadPerCore.toFixed(2)} is over the health line ${line.maxLoadPerCore}.`;
  if (availableMemoryRatio !== null && availableMemoryRatio < line.minAvailableMemoryRatio)
    return `Available memory ${percent(availableMemoryRatio)} is under the health line ${percent(line.minAvailableMemoryRatio)}.`;
  if (
    resources.serverEventLoopUtilization !== undefined &&
    resources.serverEventLoopUtilization > line.maxServerEventLoopUtilization
  )
    return `T3 server busy ${percent(resources.serverEventLoopUtilization)} is over the health line ${percent(line.maxServerEventLoopUtilization)}.`;
  if (freeDiskBytes !== null && freeDiskBytes < line.minFreeDiskBytes)
    return `Free disk ${(freeDiskBytes / GIB).toFixed(1)} GiB is under the health line ${(line.minFreeDiskBytes / GIB).toFixed(1)} GiB.`;
  return undefined;
}

export function agentPlacementResourcesFresh(
  resources: HostResourcesSnapshot | null | undefined,
  now: number,
): resources is HostResourcesSnapshot {
  return (
    resources != null &&
    now - resources.sampledAt <= 15_000 &&
    resources.sampledAt <= now + 5_000 &&
    resources.cpuCount > 0 &&
    resources.totalMemoryBytes > 0
  );
}

export function scoreAgentPlacement(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly resources: HostResourcesSnapshot | null | undefined;
  readonly weight: number;
  readonly line: AgentPlacementHealthLine;
  readonly now: number;
  readonly room?: AgentPlacementRoom | undefined;
}): AgentPlacementScore {
  const { resources, weight, line, room } = input;
  const loadPerCore =
    resources == null || resources.cpuCount <= 0 || resources.loadAverage1m === undefined
      ? null
      : resources.loadAverage1m / resources.cpuCount;
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
    ...(room === undefined ? {} : { room }),
  };
  const skip = (skipped: string): AgentPlacementScore => ({ ...base, score: 0, skipped });
  if (!Number.isFinite(weight) || weight <= 0) return skip("Weight is 0.");
  if (room?.paused !== undefined) return skip(`Paused: ${room.paused}`);
  if (resources == null) return skip("No host resources reported.");
  if (input.now - resources.sampledAt > 15_000 || resources.sampledAt > input.now + 5_000)
    return skip("Host resources are stale.");
  if (resources.cpuCount <= 0 || availableMemoryRatio === null)
    return skip("No CPU or memory reading.");
  const breach = agentPlacementHealthBreach(resources, line);
  if (breach !== undefined) return skip(breach);
  const full = room === undefined ? undefined : agentPlacementRoomFull(input.label, room);
  if (full !== undefined) return skip(full);
  const totalDiskBytes = resources.totalDiskBytes ?? 0;
  const diskRatio =
    freeDiskBytes !== null && totalDiskBytes > 0 ? freeDiskBytes / totalDiskBytes : null;
  const unknown = [
    ...(loadPerCore === null ? ["load average"] : []),
    ...(diskRatio === null ? ["free disk"] : []),
  ];
  const freeCoreRatio =
    loadPerCore === null ? UNKNOWN_RATIO : Math.max(0, 1 - loadPerCore / line.maxLoadPerCore);
  const share = room?.cap != null && room.free !== null ? room.free / room.cap : 1;
  const score =
    share *
    weight *
    resources.cpuCount *
    freeCoreRatio *
    availableMemoryRatio *
    (diskRatio ?? UNKNOWN_RATIO);
  return unknown.length === 0
    ? { ...base, score }
    : {
        ...base,
        score,
        note: `Unknown ${unknown.join(" and ")}; each counts as 10%, so this machine is a last resort.`,
      };
}
