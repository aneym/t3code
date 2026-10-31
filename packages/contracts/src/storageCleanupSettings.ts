import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const StorageRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
export const SettledWorktreeRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
);

export const DisposableIgnoredPaths = Schema.Array(
  TrimmedNonEmptyString.check(
    Schema.isMaxLength(200),
    Schema.isPattern(/^(?!(?:[\w.*?[\]!@+~/-]*\/)?\.\.(?:\/|$))[\w.*?[\]!@+~/-]+$/),
  ),
).check(Schema.isMaxLength(50));

export const WorktreeKeepWhen = Schema.Literals([
  "any-local-files",
  "uncommitted-changes",
  "tracked-changes",
]);
export type WorktreeKeepWhen = typeof WorktreeKeepWhen.Type;

export const WorktreeCleanupRules = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays,
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean,
  worktreeOnDelete: Schema.Boolean,
  worktreeUnchanged: Schema.Boolean,
  worktreeRequireIntegrated: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeContentIntegration: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
});
export type WorktreeCleanupRules = typeof WorktreeCleanupRules.Type;
export const WorktreeCleanupRulesPatchFields = {
  worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
  worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
  worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
  worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
  worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
  worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
  worktreeRequireIntegrated: Schema.optionalKey(Schema.Boolean),
  worktreeContentIntegration: Schema.optionalKey(Schema.Boolean),
};

export const WorktreeCleanup = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ mode: Schema.Literal("off") }),
    Schema.Struct({ mode: Schema.Literal("custom"), rules: WorktreeCleanupRules }),
  ]),
);
export type WorktreeCleanup = typeof WorktreeCleanup.Type;

export const StorageCleanupSettings = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeOnDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeUnchanged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeRequireIntegrated: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeContentIntegration: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  browserArtifactsAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  logsAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  worktreeOrphans: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeDisposableIgnoredPaths: DisposableIgnoredPaths.pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type StorageCleanupSettings = typeof StorageCleanupSettings.Type;
