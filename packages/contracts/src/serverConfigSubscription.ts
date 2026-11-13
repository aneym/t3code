import * as Schema from "effect/Schema";

export const ServerConfigSubscriptionInput = Schema.Struct({
  /** Opt-in protects older clients that reject unknown theme event types. */
  environmentThemes: Schema.optional(Schema.Boolean),
  usageLimitSources: Schema.optional(Schema.Boolean),
  /** Advertise client handling before the server offers /usage-limits, or older clients send it as a prompt. */
  usageLimitsCommand: Schema.optional(Schema.Boolean),
  /** Omit per-cwd provider snapshots; the client fetches its cwd through `server.refreshProviders`. */
  workspaceSnapshotsOnDemand: Schema.optional(Schema.Boolean),
  /** With on-demand snapshots, also omit machine slash commands and skills a cwd snapshot replaces. */
  providerCatalogsOnDemand: Schema.optional(Schema.Boolean),
  /**
   * With on-demand catalogs, send a `catalogDigest` in place of the machine slash command names
   * and skills. The client keeps the lists it holds and loads new ones with a cwd snapshot.
   */
  providerCatalogDigests: Schema.optional(Schema.Boolean),
  /** Send provider changes as `providerStatusDeltas`; older clients reject the event type. */
  providerStatusDeltas: Schema.optional(Schema.Boolean),
});
