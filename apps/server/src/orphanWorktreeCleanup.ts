import {
  OrchestrationV2ProviderSessionJson,
  type ServerSettings,
  type StorageCleanupReportEntry,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "./config.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as Settings from "./serverSettings.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { makeWorktreeIntegrationCheck } from "./worktreeIntegration.ts";
import { makeWorktreePublicationCheck } from "./worktreePublication.ts";
import { makeWorktreeSafetyChecks } from "./worktreeSafetyChecks.ts";
import { makeWorktreeTrash, WORKTREE_TRASH_FOLDER } from "./worktreeTrash.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";

const decodeSession = Schema.decodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

export const makeOrphanWorktreeCleanup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const trash = yield* makeWorktreeTrash;
  const safety = yield* makeWorktreeSafetyChecks;
  const key = (target: string) =>
    platform === "win32" ? path.resolve(target).toLowerCase() : path.resolve(target);
  const contains = (root: string, target: string) => {
    const relative = path.relative(key(root), key(target));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  const bindingReason = Effect.fn("StorageCleanup.orphanBindings")(function* (cwd: string) {
    const rows = yield* sql<{ worktreePath: string }>`
      SELECT DISTINCT json_extract(t.payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads t
      WHERE json_extract(t.payload_json, '$.worktreePath') IS NOT NULL
        AND (t.deleted_at IS NULL OR EXISTS (
          SELECT 1 FROM orchestration_v2_effect_outbox e
          WHERE e.thread_id = t.thread_id AND e.status NOT IN ('succeeded', 'cancelled')
        ))
    `.pipe(NodeSqliteClient.readOnly);
    for (const row of rows) {
      const resolved = path.resolve(row.worktreePath);
      const real = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
      if (contains(cwd, resolved) || contains(cwd, real)) return "thread binding exists";
    }
    for (const project of yield* projects.list({ includeDeleted: true })) {
      const resolved = path.resolve(project.workspaceRoot);
      const real = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
      if (contains(cwd, resolved) || contains(cwd, real)) return "contains a project checkout";
    }
    const activeSessions = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'
    `.pipe(NodeSqliteClient.readOnly);
    for (const row of activeSessions) {
      const session = yield* decodeSession(row.payload_json);
      const real = yield* fs
        .realPath(session.cwd)
        .pipe(Effect.orElseSucceed(() => path.resolve(session.cwd)));
      if (
        (contains(cwd, session.cwd) || contains(cwd, real)) &&
        (yield* sessions.isLive(session.id))
      )
        return "provider session is still open";
    }
    return null;
  });
  const inspectHolders = Effect.fn("StorageCleanup.orphanHolders")(
    function* (cwd: string | undefined) {
      if (platform !== "darwin" && platform !== "linux")
        return { reason: "lsof-unavailable", paths: [] };
      const result = yield* processRunner.run({
        command: "lsof",
        args:
          cwd === undefined
            ? ["-w", "-n", "-P", "-a", "-d", "cwd", "-Fpn"]
            : ["-w", "-n", "-P", "-Fpn", "+D", cwd],
        cwd: config.cwd,
        timeout: "30 seconds",
        maxOutputBytes: 8 * 1024 * 1024,
        outputMode: "truncate",
      });
      if (result.stdoutTruncated || result.stderrTruncated)
        return { reason: "lsof-output-truncated", paths: [] };
      if (result.stdoutInvalidUtf8 || result.stderrInvalidUtf8)
        return { reason: "lsof-invalid-utf8", paths: [] };
      const errors = result.stderr
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            line !== "" &&
            !/^(?:lsof: )?WARNING: can't stat\(\)/.test(line) &&
            !/^(?:lsof: )?Output information may be incomplete\.?$/.test(line),
        );
      if (errors.length > 0) return { reason: "lsof-stderr-error", paths: [] };
      if (cwd !== undefined && result.stdout.trim() !== "")
        return { reason: "live process holder", paths: [] };
      if (cwd !== undefined && result.code === 1 && result.stdout.trim() === "")
        return { reason: null, paths: [] };
      if (result.code !== 0) return { reason: "lsof-failed", paths: [] };
      if (cwd !== undefined)
        return {
          reason: result.stdout.trim() === "" ? "lsof-empty-output" : "live process holder",
          paths: [],
        };
      const paths = new Set<string>();
      for (const line of new Set(result.stdout.split("\n"))) {
        if (!line.startsWith("n/")) continue;
        const current = line.slice(1);
        paths.add(current);
        paths.add(yield* fs.realPath(current).pipe(Effect.orElseSucceed(() => current)));
      }
      return { reason: null, paths: [...paths] };
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause(() => Effect.succeed({ reason: "lsof-execution-failed", paths: [] })),
      ),
  );

  return Effect.fn("StorageCleanup.cleanOrphans")(function* (
    settings: ServerSettings,
    entries: StorageCleanupReportEntry[],
    hasTerminal: (cwd: string) => boolean,
  ) {
    if (!settings.storageCleanup.worktreeOrphans) return;
    const roots = yield* trash.managedRoots(settings, config.worktreesDir);
    const policy = resolveWorktreeCleanup(settings, null);
    const rules = {
      ...policy,
      worktreeKeepWhen:
        policy.worktreeKeepWhen === "tracked-changes"
          ? ("uncommitted-changes" as const)
          : policy.worktreeKeepWhen,
    };
    const disposable = settings.storageCleanup.worktreeDisposableIgnoredPaths;
    const integration = makeWorktreeIntegrationCheck(git);
    const publication = makeWorktreePublicationCheck(git);
    const graceMs = Math.max(
      3_600_000,
      settings.storageCleanup.worktreeAcceptPushed
        ? (policy.worktreeSettledAfterDays ?? 0) * 86_400_000
        : 0,
    );
    const candidates = new Set<string>();
    const skipped: Record<string, number> = {};
    let removed = 0;
    const discover = Effect.fn("StorageCleanup.discoverOrphans")(function* (
      directory: string,
      depth: number,
    ): Effect.fn.Return<void, PlatformError> {
      for (const name of yield* fs.readDirectory(directory)) {
        if (name === WORKTREE_TRASH_FOLDER) continue;
        const target = path.join(directory, name);
        if (
          yield* fs.readLink(target).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        )
          continue;
        if ((yield* fs.stat(target)).type !== "Directory") continue;
        const gitPath = path.join(target, ".git");
        if (yield* fs.exists(gitPath)) {
          if ((yield* fs.stat(gitPath)).type === "File") candidates.add(target);
        } else if (depth > 0) yield* discover(target, depth - 1);
      }
    });
    for (const root of roots)
      yield* discover(root, 1).pipe(
        Effect.catch(() => {
          skipped["discovery failed"] = (skipped["discovery failed"] ?? 0) + 1;
          return Effect.logWarning("orphan worktree discovery failed");
        }),
      );
    const holders =
      candidates.size > 0 ? yield* inspectHolders(undefined) : { reason: null, paths: [] };
    for (const cwd of candidates) {
      const entry: StorageCleanupReportEntry = {
        kind: "worktree",
        outcome: "kept",
        reason: "",
        path: cwd,
        projectPath: null,
        threadId: null,
        threadTitle: null,
        bytes: null,
        files: null,
      };
      const keep = (reason: string) => {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
        if (!entries.some((previous) => previous.path === cwd)) entries.push({ ...entry, reason });
      };
      let failureReason = "inspection-failed: bindings";
      yield* Effect.gen(function* () {
        const initialBinding = yield* bindingReason(cwd);
        if (initialBinding !== null) return keep(initialBinding);
        failureReason = "inspection-failed: worktree-stat";
        const info = yield* fs.stat(cwd).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(null),
          ),
        );
        if (info === null) return keep("worktree no longer exists");
        const modified = Option.getOrNull(info.mtime);
        if (modified === null || modified.getTime() > (yield* Clock.currentTimeMillis) - graceMs)
          return keep("worktree was created or modified recently");
        const run = (args: string[]) =>
          git.execute({ operation: "StorageCleanup.orphan", cwd, args });
        failureReason = "inspection-failed: git-registration";
        const admin = (yield* run(["rev-parse", "--absolute-git-dir"])).stdout.trim();
        const common = yield* fs.realPath(
          (yield* run(["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim(),
        );
        const listing = yield* run(["worktree", "list", "--porcelain", "-z"]);
        if (listing.stdoutTruncated) return keep("worktree listing is truncated");
        const registered = listing.stdout
          .split("\0")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice(9));
        const repository = registered[0];
        if (repository === undefined || !registered.some((target) => key(target) === key(cwd)))
          return keep("worktree registration is unavailable");
        failureReason = "inspection-failed: branch-head";
        const branchHead = yield* git.execute({
          operation: "StorageCleanup.orphanBranchHead",
          cwd,
          args: ["symbolic-ref", "--quiet", "HEAD"],
          allowNonZeroExit: true,
        });
        if (branchHead.stdoutTruncated || branchHead.stderrTruncated)
          return keep("branch-head-inspection-truncated");
        if (branchHead.exitCode === 1 && branchHead.stderr.trim() === "")
          return keep("detached HEAD");
        if (branchHead.exitCode !== 0) return keep("branch-head-symbolic-ref-failed");
        const ref = branchHead.stdout.trim();
        if (!ref.startsWith("refs/heads/")) return keep("branch-head-ref-unavailable");
        const branch = ref.slice("refs/heads/".length);
        failureReason = "inspection-failed: branch-head-commit";
        const commit = yield* git.resolveCommit({ cwd, revision: "HEAD" }).pipe(Effect.option);
        if (Option.isNone(commit))
          return keep("HEAD commit could not be resolved (unborn or invalid branch)");
        const head = commit.value.commitSha;
        const identity = Effect.fn("StorageCleanup.orphanIdentity")(function* () {
          if (
            (yield* fs.realPath(cwd)) !==
            path.join(yield* fs.realPath(path.dirname(cwd)), path.basename(cwd))
          )
            return "worktree is a symbolic link";
          if (
            yield* fs.readLink(path.join(cwd, ".git")).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          )
            return "Git file is a symbolic link";
          if ((yield* fs.stat(path.join(cwd, ".git"))).type !== "File")
            return "not a linked worktree";
          if ((yield* run(["rev-parse", "--absolute-git-dir"])).stdout.trim() !== admin)
            return "worktree registration changed";
          if (
            (yield* fs.realPath(
              (yield* run([
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
              ])).stdout.trim(),
            )) !== common
          )
            return "worktree repository changed";
          if (
            (yield* fs.realPath((yield* fs.readFileString(path.join(admin, "gitdir"))).trim())) !==
            (yield* fs.realPath(path.join(cwd, ".git")))
          )
            return "worktree registration changed";
          if (yield* fs.exists(path.join(admin, "locked"))) return "worktree is locked";
          if (yield* safety.branchChanged(cwd, branch)) return "repository or branch changed";
          if ((yield* git.resolveCommit({ cwd, revision: "HEAD" })).commitSha !== head)
            return "commit changed since check";
          return null;
        });
        const ready = Effect.fn("StorageCleanup.orphanReady")(function* (freshHolders: boolean) {
          failureReason = "inspection-failed: identity";
          const moved = yield* identity();
          if (moved !== null) return moved;
          if (holders.reason !== null) return holders.reason;
          if (holders.paths.some((current) => contains(cwd, current))) return "live process cwd";
          failureReason = "inspection-failed: submodules";
          const submodules = yield* safety.submoduleKeepReason(cwd, rules);
          if (submodules !== null) return submodules;
          failureReason = "inspection-failed: personal-state";
          const personal = yield* trash.personalStateReason(cwd, disposable);
          if (personal !== null) return personal;
          failureReason = "inspection-failed: keep-marker";
          for (const marker of ["keep-lane-state", ".keep-lane-state"])
            if (yield* fs.exists(path.join(cwd, marker))) return "keep-lane-state marker exists";
          failureReason = "inspection-failed: local-changes";
          const changes = yield* safety.localChangesReason(cwd, rules);
          if (changes !== null) return changes;
          if (hasTerminal(cwd)) return "open terminal";
          failureReason = "inspection-failed: settings";
          const current = yield* settingsService.getSettings;
          if (
            !current.storageCleanup.worktreeOrphans ||
            !Equal.equals(current.storageCleanup, settings.storageCleanup) ||
            current.worktreesDirectory !== settings.worktreesDirectory ||
            !Equal.equals(
              current.previousWorktreesDirectories,
              settings.previousWorktreesDirectories,
            )
          )
            return "settings changed since check";
          failureReason = "inspection-failed: final-identity";
          const finalIdentity = yield* identity();
          if (finalIdentity !== null) return finalIdentity;
          failureReason = "inspection-failed: final-bindings";
          const binding = yield* bindingReason(cwd);
          if (binding !== null) return binding;
          return freshHolders ? (yield* inspectHolders(cwd)).reason : null;
        });
        const early = yield* ready(false);
        if (early !== null) return keep(early);
        failureReason = "publication-check-failed";
        const pushed = yield* publication({
          repositoryCwd: repository,
          worktreePath: cwd,
          headSha: head,
        });
        failureReason = "integration-check-failed";
        const landed = pushed
          ? null
          : yield* integration({
              repositoryCwd: repository,
              worktreePath: cwd,
              headSha: head,
              matchContent: rules.worktreeContentIntegration,
            });
        if (typeof landed === "string") return keep(landed);
        if (!pushed && !landed?.integrated) return keep("branch-not-published-or-integrated");
        failureReason = "inspection-failed: final-readiness";
        const final = yield* ready(true);
        if (final !== null) return keep(final);
        failureReason = "removal-failed";
        const root = roots.find((root) => contains(root, cwd));
        if (root === undefined) return keep("managed root changed since check");
        const removal = yield* trash.remove(root, cwd, repository, () => ready(true));
        if (removal !== null) return keep(removal);
        removed++;
        entries.push({
          ...entry,
          outcome: "removed",
          reason: "Orphaned worktree is published or integrated",
        });
      }).pipe(
        (effect) => withWorkspaceLease(cwd, effect),
        Effect.catch((error) =>
          Effect.sync(() =>
            keep(
              error._tag === "GitCommandError" &&
                error.operation === "GitVcsDriver.fetchRemoteTrackingBranch"
                ? "fetch-failed"
                : `${failureReason} (${error._tag})`,
            ),
          ),
        ),
      );
    }
    yield* Effect.logInfo("orphan worktree cleanup completed", { removed, skipped });
  });
});
