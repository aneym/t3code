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
   * A model picker opened: refetch a model manifest older than a few minutes and probe providers
   * only when it changed. The other fields are ignored and the config stream carries the result.
   */
  modelCatalogOnly: Schema.optional(Schema.Boolean),
  /** Read secret references again; unlocking a vault can prompt on the host, so only explicit user refreshes ask. */
  reloadSecrets: Schema.optional(Schema.Boolean),
  /**
   * Reply without snapshots, or with only the requested instance's cwd snapshot. Snapshots then
   * reach the client only through these replies, so another client's scan shows on its next
   * refresh, at most one TTL later.
   */
  workspaceSnapshotsOnDemand: Schema.optional(Schema.Boolean),
  /** As on `subscribeServerConfig`: add /usage-limits to the replied snapshot. */
  usageLimitsCommand: Schema.optional(Schema.Boolean),
  /** As on `subscribeServerConfig`: a failed cwd scan replies with the machine catalog as a pending snapshot. */
  providerCatalogsOnDemand: Schema.optional(Schema.Boolean),
  /**
   * Reply with no providers; the config stream carries the result. For callers that only wait
   * for the refresh. Ignored with `instanceId` and `cwd`, whose reply is the snapshot.
   */
  omitProviders: Schema.optional(Schema.Boolean),
  /**
   * With `providerCatalogsOnDemand`, a cwd reply also carries the machine slash command names
   * and skills with their `catalogDigest`. Sent by a client whose held lists are not current.
   */
  machineCatalog: Schema.optional(Schema.Boolean),
});
