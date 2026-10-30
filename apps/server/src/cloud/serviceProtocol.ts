import type { ServerSelfUpdateOutcome } from "@t3tools/contracts/serverLifecycle";

// Bump for incompatible runtime layout changes; launchers survive self-updates. Protocol 3 requires standalone executables.
export const SERVICE_LAUNCHER_PROTOCOL = 3 as const;
export const SERVICE_LAUNCHER_CONTEXT_ENV = "T3_SERVICE_LAUNCHER_CONTEXT";
export const SERVICE_ENV_FILE = "service.env";
export const SERVICE_STATE_FILE = "service-state.json";
/** Written before explicit stop to distinguish shutdown from update handoff. */
export const SERVICE_STOP_MARKER_FILE = ".service-stopping";
/** Marks a repointed unit whose service still runs the old version; launcher startup clears it. */
export const SERVICE_RESTART_PENDING_FILE = ".restart-pending";
export const SERVER_OWNER_LOCK_FILE = "server-owner.sqlite";

export interface PendingServiceUpdate {
  readonly id: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly dbPath: string;
  readonly status: "pending";
}

export type ServiceUpdateRecord = PendingServiceUpdate | ServerSelfUpdateOutcome;

export interface ServiceState {
  readonly protocol: typeof SERVICE_LAUNCHER_PROTOCOL;
  readonly activeVersion: string;
  readonly update?: ServiceUpdateRecord;
}

export interface ServiceLauncherContext {
  readonly protocol: typeof SERVICE_LAUNCHER_PROTOCOL;
  readonly childVersion: string;
  readonly hotSwap?: {
    readonly instanceId: string;
    readonly warm: boolean;
    readonly protocol: number;
    readonly publicHost: string;
    readonly publicPort: number;
    readonly holdBudgetMs: number;
  };
  readonly update?: ServiceUpdateRecord;
}

export interface ServiceConnectorFacts {
  readonly readyConnections: number | null;
  readonly hostname: string | null;
  readonly protocol: string | null;
}

export type ServiceLauncherChildMessage =
  | { readonly type: "capability-rejected"; readonly reason: "unsupported-hot-swap" }
  | {
      readonly type: "freeze-aborted";
      readonly updateId: string;
      readonly reason: "freeze-timeout" | "freeze-failed";
    }
  | { readonly type: "socket-accepted"; readonly transferId: number }
  | { readonly type: "socket-returned"; readonly transferId: number; readonly prefix?: string }
  | { readonly type: "ingress-ready"; readonly host: string; readonly port: number }
  | { readonly type: "warm"; readonly updateId: string; readonly willMigrate: boolean }
  | { readonly type: "drained"; readonly updateId: string }
  | { readonly type: "drain-failed"; readonly updateId: string }
  | { readonly type: "validated"; readonly updateId: string; readonly port: number }
  | { readonly type: "listening"; readonly port: number }
  | { readonly type: "state-dir-owned" }
  | {
      readonly type: "request-update";
      readonly targetVersion: string;
      readonly dbPath: string;
      readonly allowDowngrade?: boolean;
    }
  | {
      readonly type: "prepared";
      readonly updateId: string;
    };

export interface ServiceConnectorConfig {
  readonly executable: string;
  readonly token: string;
  readonly tunnelId?: string;
  readonly tunnelName?: string;
}

export type ServiceLauncherParentMessage =
  | { readonly type: "ingress-bound" }
  | { readonly type: "acquire"; readonly updateId: string }
  | { readonly type: "drain"; readonly updateId: string; readonly drainTimeoutMs: number }
  | { readonly type: "relinquish"; readonly updateId: string }
  | { readonly type: "abort-drain"; readonly updateId: string }
  | { readonly type: "socket"; readonly transferId: number; readonly prefix?: string }
  | {
      readonly type: "update-accepted";
      readonly updateId: string;
    }
  | {
      readonly type: "update-rejected";
      readonly reason: string;
    }
  | {
      readonly type: "committed";
      readonly updateId: string;
    };

const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE = `(?:${SEMVER_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const EXACT_SERVICE_VERSION = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE}(?:\\.${SEMVER_PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

export const isExactServiceVersion = (version: string): boolean =>
  EXACT_SERVICE_VERSION.test(version);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodeServiceUpdate(value: unknown): ServiceUpdateRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { id, fromVersion, targetVersion, status } = value;
  if (
    typeof id !== "string" ||
    id.trim() === "" ||
    typeof fromVersion !== "string" ||
    !isExactServiceVersion(fromVersion) ||
    typeof targetVersion !== "string" ||
    !isExactServiceVersion(targetVersion)
  ) {
    return undefined;
  }
  if (status === "pending") {
    return typeof value.dbPath === "string" && value.dbPath.trim() !== ""
      ? { id, fromVersion, targetVersion, dbPath: value.dbPath, status }
      : undefined;
  }
  if (
    (status === "committed" || status === "rolled-back" || status === "failed") &&
    (value.reason === undefined || (typeof value.reason === "string" && value.reason.trim() !== ""))
  ) {
    return {
      id,
      fromVersion,
      targetVersion,
      status,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  return undefined;
}

export function compareExactServiceVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const withoutBuild = version.split("+", 1)[0] ?? version;
    const separator = withoutBuild.indexOf("-");
    const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
    const prerelease = separator === -1 ? undefined : withoutBuild.slice(separator + 1);
    const [major = "0", minor = "0", patch = "0"] = core.split(".");
    return {
      core: [BigInt(major), BigInt(minor), BigInt(patch)] as const,
      prerelease: prerelease?.split(".") ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const x = a.core[index] ?? 0n;
    const y = b.core[index] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function decodeServiceState(value: unknown): ServiceState | undefined {
  if (!isRecord(value)) return undefined;
  const update = value.update === undefined ? undefined : decodeServiceUpdate(value.update);
  if (
    value.protocol !== SERVICE_LAUNCHER_PROTOCOL ||
    typeof value.activeVersion !== "string" ||
    !isExactServiceVersion(value.activeVersion) ||
    (value.update !== undefined && update === undefined) ||
    (update !== undefined &&
      compareExactServiceVersions(update.targetVersion, update.fromVersion) === 0) ||
    (update?.status === "pending" && update.fromVersion !== value.activeVersion) ||
    (update?.status === "committed" && update.targetVersion !== value.activeVersion) ||
    ((update?.status === "rolled-back" || update?.status === "failed") &&
      update.fromVersion !== value.activeVersion)
  ) {
    return undefined;
  }
  return {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    activeVersion: value.activeVersion,
    ...(update === undefined ? {} : { update }),
  };
}

export function parseServiceState(value: string): ServiceState | undefined {
  try {
    return decodeServiceState(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

export function serviceStateHasPendingUpdate(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && isRecord(parsed.update) && parsed.update.status === "pending";
  } catch {
    return false;
  }
}

export function serviceStateActiveVersion(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) &&
      typeof parsed.activeVersion === "string" &&
      isExactServiceVersion(parsed.activeVersion)
      ? parsed.activeVersion
      : undefined;
  } catch {
    return undefined;
  }
}

export function decodeServiceLauncherContext(value: string): ServiceLauncherContext | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.protocol !== SERVICE_LAUNCHER_PROTOCOL ||
    typeof parsed.childVersion !== "string" ||
    !isExactServiceVersion(parsed.childVersion)
  ) {
    return undefined;
  }
  const update = parsed.update === undefined ? undefined : decodeServiceUpdate(parsed.update);
  if (parsed.update !== undefined && update === undefined) return undefined;
  const selectedVersion =
    update?.status === "pending" || update?.status === "committed"
      ? update.targetVersion
      : update === undefined
        ? parsed.childVersion
        : update.fromVersion;
  if (parsed.childVersion !== selectedVersion) {
    return undefined;
  }
  if (
    parsed.hotSwap !== undefined &&
    !(
      isRecord(parsed.hotSwap) &&
      typeof parsed.hotSwap.instanceId === "string" &&
      typeof parsed.hotSwap.warm === "boolean" &&
      parsed.hotSwap.protocol === 1 &&
      typeof parsed.hotSwap.publicHost === "string" &&
      typeof parsed.hotSwap.publicPort === "number" &&
      typeof parsed.hotSwap.holdBudgetMs === "number"
    )
  )
    return undefined;
  return {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    childVersion: parsed.childVersion,
    ...(parsed.hotSwap === undefined
      ? {}
      : { hotSwap: parsed.hotSwap as NonNullable<ServiceLauncherContext["hotSwap"]> }),
    ...(update === undefined ? {} : { update }),
  };
}

export function decodeServiceLauncherChildMessage(
  value: unknown,
): ServiceLauncherChildMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "capability-rejected" && value.reason === "unsupported-hot-swap")
    return { type: value.type, reason: value.reason };
  if (
    value.type === "freeze-aborted" &&
    typeof value.updateId === "string" &&
    (value.reason === "freeze-timeout" || value.reason === "freeze-failed")
  )
    return { type: value.type, updateId: value.updateId, reason: value.reason };
  if (
    (value.type === "socket-accepted" || value.type === "socket-returned") &&
    typeof value.transferId === "number"
  )
    return {
      type: value.type,
      transferId: value.transferId,
      ...(typeof value.prefix === "string" ? { prefix: value.prefix } : {}),
    };
  if (
    value.type === "ingress-ready" &&
    typeof value.host === "string" &&
    typeof value.port === "number"
  )
    return { type: value.type, host: value.host, port: value.port };
  if (
    value.type === "warm" &&
    typeof value.updateId === "string" &&
    typeof value.willMigrate === "boolean"
  )
    return { type: value.type, updateId: value.updateId, willMigrate: value.willMigrate };
  if (
    (value.type === "drained" || value.type === "drain-failed") &&
    typeof value.updateId === "string"
  )
    return { type: value.type, updateId: value.updateId };
  if (
    value.type === "validated" &&
    typeof value.updateId === "string" &&
    typeof value.port === "number"
  )
    return { type: value.type, updateId: value.updateId, port: value.port };
  if (value.type === "listening" && typeof value.port === "number")
    return { type: value.type, port: value.port };
  if (value.type === "state-dir-owned") return { type: value.type };
  if (
    value.type === "request-update" &&
    typeof value.targetVersion === "string" &&
    typeof value.dbPath === "string" &&
    (value.allowDowngrade === undefined || typeof value.allowDowngrade === "boolean")
  ) {
    return {
      type: value.type,
      targetVersion: value.targetVersion,
      dbPath: value.dbPath,
      ...(value.allowDowngrade === undefined ? {} : { allowDowngrade: value.allowDowngrade }),
    };
  }
  return value.type === "prepared" && typeof value.updateId === "string"
    ? { type: value.type, updateId: value.updateId }
    : undefined;
}

export function decodeServiceLauncherParentMessage(
  value: unknown,
): ServiceLauncherParentMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "ingress-bound") return { type: value.type };
  if (value.type === "socket" && typeof value.transferId === "number")
    return {
      type: value.type,
      transferId: value.transferId,
      ...(typeof value.prefix === "string" ? { prefix: value.prefix } : {}),
    };
  if (
    (value.type === "acquire" || value.type === "relinquish" || value.type === "abort-drain") &&
    typeof value.updateId === "string"
  )
    return { type: value.type, updateId: value.updateId };
  if (
    value.type === "drain" &&
    typeof value.updateId === "string" &&
    typeof value.drainTimeoutMs === "number"
  )
    return { type: value.type, updateId: value.updateId, drainTimeoutMs: value.drainTimeoutMs };
  if (value.type === "update-rejected" && typeof value.reason === "string") {
    return { type: value.type, reason: value.reason };
  }
  if (value.type === "update-accepted" && typeof value.updateId === "string") {
    return { type: value.type, updateId: value.updateId };
  }
  return value.type === "committed" && typeof value.updateId === "string"
    ? { type: value.type, updateId: value.updateId }
    : undefined;
}

export function unsupportedServiceHotSwap(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      isRecord(parsed) &&
      Object.hasOwn(parsed, "hotSwap") &&
      decodeServiceLauncherContext(value) === undefined
    );
  } catch {
    return false;
  }
}
