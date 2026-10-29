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
    ) => Effect.Effect<
      ReadonlyArray<{ readonly name: string; readonly commit: string }>,
      GitCommandError
    >;
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
      readonly branches: ReadonlyArray<string>;
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
      "--format=%(objectname) %(refname:short)",
      "refs/remotes",
    ]).pipe(
      Effect.map((stdout) =>
        (stdout ?? "")
          .split("\n")
          .map((line) => {
            const [commit = "", name = ""] = line.split(" ");
            return { commit, name };
          })
          .filter(({ name }) => name.length > 0 && !name.endsWith("/HEAD")),
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
    const names = containing.map(({ name }) => name);
    const fetchable = upstream !== null && names.includes(upstream) ? upstream : (names[0] ?? null);
    return { commit, fetchable };
  });

  const exportBranch: WorktreeTransfer["Service"]["exportBranch"] = Effect.fn(
    "WorktreeTransfer.exportBranch",
  )(function* ({ worktreePath, branch, bases, branches }) {
    const cwd = worktreePath;
    const headCommit = yield* required(
      "export.head",
      cwd,
      ["rev-parse", "HEAD"],
      "No commit",
      false,
    );
    const forksOf = (refs: ReadonlyArray<string>) =>
      Effect.forEach(refs, (ref) =>
        run("export.base", cwd, ["merge-base", ref, headCommit]).pipe(
          Effect.mapError((cause) => transferError(cause.message)),
        ),
      ).pipe(Effect.map((forks) => forks.filter((fork): fork is string => fork !== null)));
    const had = yield* forksOf(bases);
    if (had.length === 0)
      return yield* transferError(`None of ${bases.join(", ")} is in this repository`, false);
    const counted = yield* Effect.forEach([...had, ...(yield* forksOf(branches))], (fork) =>
      required(
        "export.count",
        cwd,
        ["rev-list", "--count", `${fork}..${headCommit}`],
        "Unable to count commits",
      ).pipe(Effect.map((count) => ({ fork, count: Number(count) }))),
    );
    const { fork: baseCommit, count: commitCount } = counted
      .filter(({ fork, count }) => count > 0 || had.includes(fork))
      .reduce((best, next) => (next.count < best.count ? next : best));
    const exclude = had.map((fork) => `^${fork}`);
    const missing = Number(
      yield* required(
        "export.missing",
        cwd,
        ["rev-list", "--count", headCommit, ...exclude],
        "Unable to count commits",
      ),
    );
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
    if (missing === 0) return { ...summary, bundle: null };
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
          "import.verify",
          cwd,
          ["bundle", "verify", "--quiet", file],
          "This checkout lacks a commit the bundle builds on",
          false,
        );
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
