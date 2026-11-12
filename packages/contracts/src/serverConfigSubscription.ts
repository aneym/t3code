import * as Schema from "effect/Schema";

export const ServerConfigSubscriptionInput = Schema.Struct({
  /** Opt-in protects older clients that reject unknown theme event types. */
  environmentThemes: Schema.optional(Schema.Boolean),
  usageLimitSources: Schema.optional(Schema.Boolean),
  /** Advertise client handling before the server offers /usage-limits, or older clients send it as a prompt. */
  usageLimitsCommand: Schema.optional(Schema.Boolean),
  /** Omit per-cwd provider snapshots; the client fetches its cwd through `server.refreshProviders`. */
  workspaceSnapshotsOnDemand: Schema.optional(Schema.Boolean),
  /** Send providers without global skills and slash commands; the composer reads its cwd snapshot instead. */
  providerCatalogsOnDemand: Schema.optional(Schema.Boolean),
});
