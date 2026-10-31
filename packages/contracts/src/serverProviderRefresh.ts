import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ServerProviderRefreshInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  fresh: Schema.optional(Schema.Boolean),
  /** Bypass model caches; explicit rediscovery may open sessions, background refreshes must not. */
  refreshModels: Schema.optional(Schema.Boolean),
  /**
   * Reply without snapshots, or with only the requested instance's cwd snapshot. Snapshots then
   * reach the client only through these replies, so another client's scan shows on its next
   * refresh, at most one TTL later.
   */
  workspaceSnapshotsOnDemand: Schema.optional(Schema.Boolean),
  /** As on `subscribeServerConfig`: add /usage-limits to the replied snapshot. */
  usageLimitsCommand: Schema.optional(Schema.Boolean),
});
