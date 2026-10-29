import type { GitCommandError, WorktreeMcpExportResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_STAT_BYTES = 4_000;

export class WorktreeTransfer extends Context.Service<
  WorktreeTransfer,
  {
    readonly remoteBranchesContaining: (
      cwd: string,
      commit: string,
    ) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
    readonly resolveBase: (
      cwd: string,
    ) => Effect.Effect<
      { readonly commit: string; readonly fetchable: string | null },
      GitCommandError
    >;
    readonly exportBranch: (input: {
      readonly worktreePath: string;
      readonly branch: string;
      readonly bases: ReadonlyArray<string>;
    }) => Effect.Effect<WorktreeMcpExportResult, WorktreeTransferError>;
    readonly importBranch: (input: {
      readonly cwd: string;
      readonly exported: WorktreeMcpExportResult & { readonly bundle: string };
      readonly suffix: string;
    }) => Effect.Effect<string, WorktreeTransferError>;
  }
>()("t3/peer/WorktreeTransfer") {}

export class WorktreeTransferError extends Schema.TaggedError<WorktreeTransferError>()(
  "WorktreeTransferError",
  { message: Schema.String, retryable: Schema.Boolean },
) {}

const transferError = (message: string, retryable = true) =>
  new WorktreeTransferError({ message, retryable });
const isTransferError = Schema.is(WorktreeTransferError);

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;

  const run = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation: `WorktreeTransfer.${operation}`, cwd, args, allowNonZeroExit: true })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)));

  const required = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    why: string,
    retryable = true,
  ) =>
    run(operation, cwd, args).pipe(
      Effect.mapError((cause) => transferError(`${why}: ${cause.message}`)),
      Effect.filterOrFail(
        (stdout): stdout is string => stdout !== null,
        () => transferError(why, retryable),
      ),
    );

  const remoteBranchesContaining: WorktreeTransfer["Service"]["remoteBranchesContaining"] = (
    cwd,
    commit,
  ) =>
    run("remoteBranchesContaining", cwd, [
      "for-each-ref",
      "--contains",
      commit,
      "--format=%(refname:short)",
      "refs/remotes",
    ]).pipe(
      Effect.map((stdout) =>
        (stdout ?? "").split("\n").filter((ref) => ref.length > 0 && !ref.endsWith("/HEAD")),
      ),
    );

  const resolveBase: WorktreeTransfer["Service"]["resolveBase"] = Effect.fn(
    "WorktreeTransfer.resolveBase",
  )(function* (cwd) {
    const commit = yield* git
      .execute({
        operation: "WorktreeTransfer.resolveBase",
        cwd,
        args: ["rev-parse", "--verify", "HEAD^{commit}"],
      })
      .pipe(Effect.map((result) => result.stdout.trim()));
    const upstream = yield* run("resolveBase.upstream", cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    const containing = yield* remoteBranchesContaining(cwd, commit);
    const fetchable =
      upstream !== null && containing.includes(upstream) ? upstream : (containing[0] ?? null);
    return { commit, fetchable };
  });

  const exportBranch: WorktreeTransfer["Service"]["exportBranch"] = Effect.fn(
    "WorktreeTransfer.exportBranch",
  )(function* ({ worktreePath, branch, bases }) {
    const cwd = worktreePath;
    const headCommit = yield* required(
      "export.head",
      cwd,
      ["rev-parse", "HEAD"],
      "No commit",
      false,
    );
    const forks = (yield* Effect.forEach(bases, (base) =>
      run("export.base", cwd, ["merge-base", base, headCommit]).pipe(
        Effect.mapError((cause) => transferError(cause.message)),
      ),
    )).filter((fork): fork is string => fork !== null);
    if (forks.length === 0)
      return yield* transferError(`None of ${bases.join(", ")} is in this repository`, false);
    const counted = yield* Effect.forEach(forks, (fork) =>
      required(
        "export.count",
        cwd,
        ["rev-list", "--count", `${fork}..${headCommit}`],
        "Unable to count commits",
      ).pipe(Effect.map((count) => ({ fork, count: Number(count) }))),
    );
    const { fork: baseCommit, count: commitCount } = counted.reduce((best, next) =>
      next.count < best.count ? next : best,
    );
    const exclude = forks.map((fork) => `^${fork}`);
    const uncommitted =
      ((yield* run("export.status", cwd, ["status", "--porcelain"]).pipe(
        Effect.orElseSucceed(() => null),
      )) ?? "") !== "";
    const diffStat = (
      (yield* run("export.stat", cwd, ["diff", "--stat", baseCommit, headCommit]).pipe(
        Effect.orElseSucceed(() => null),
      )) ?? ""
    ).slice(-MAX_DIFF_STAT_BYTES);
    const summary = {
      worktreePath,
      branch,
      baseCommit,
      headCommit,
      commitCount,
      uncommitted,
      diffStat,
    };
    if (commitCount === 0) return { ...summary, bundle: null };
    const bundle = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.makeTempFileScoped({ prefix: "t3-worktree-export-" });
        yield* required(
          "export.bundle",
          cwd,
          ["bundle", "create", file, `refs/heads/${branch}`, ...exclude],
          "Unable to bundle the branch",
        );
        const stat = yield* fs.stat(file);
        if (Number(stat.size) > MAX_BUNDLE_BYTES) return null;
        return Buffer.from(yield* fs.readFile(file)).toString("base64");
      }),
    ).pipe(
      Effect.mapError((cause) => (isTransferError(cause) ? cause : transferError(cause.message))),
    );
    return { ...summary, bundle };
  });

  const importBranch: WorktreeTransfer["Service"]["importBranch"] = Effect.fn(
    "WorktreeTransfer.importBranch",
  )(function* ({ cwd, exported, suffix }) {
    const exists = (name: string) =>
      run("import.exists", cwd, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${name}^{commit}`,
      ]);
    let local = exported.branch;
    const existing = yield* exists(local).pipe(Effect.orElseSucceed(() => null));
    if (existing === exported.headCommit) return local;
    if (existing !== null) local = `${exported.branch}-${suffix}`;
    if ((yield* exists(local).pipe(Effect.orElseSucceed(() => null))) === exported.headCommit)
      return local;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.makeTempFileScoped({ prefix: "t3-worktree-import-" });
        yield* fs.writeFile(file, Buffer.from(exported.bundle, "base64"));
        yield* required(
          "import.fetch",
          cwd,
          ["fetch", "--no-tags", file, `refs/heads/${exported.branch}:refs/heads/${local}`],
          "Unable to fetch the branch from its bundle",
        );
      }),
    ).pipe(
      Effect.mapError((cause) => (isTransferError(cause) ? cause : transferError(cause.message))),
    );
    return local;
  });

  return WorktreeTransfer.of({ remoteBranchesContaining, resolveBase, exportBranch, importBranch });
});

export const layer = Layer.effect(WorktreeTransfer, make);
