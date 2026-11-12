import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

export function makeWorktreePublicationCheck(git: GitVcsDriver.GitVcsDriver["Service"]) {
  const remoteTips = new Map<string, ReadonlyArray<string> | null>();
  const run = (operation: string, cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
    git
      .execute({
        operation,
        cwd,
        args,
        env: { LC_ALL: "C" },
        allowNonZeroExit: true,
        timeoutMs: 120_000,
        maxOutputBytes: 16 * 1024 * 1024,
        ...(stdin === undefined ? {} : { stdin }),
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 && !result.stdoutTruncated ? result.stdout : null,
        ),
        Effect.orElseSucceed(() => null),
      );
  const listTips = Effect.fnUntraced(function* (repositoryCwd: string) {
    const remote = yield* git
      .resolvePrimaryRemoteName(repositoryCwd)
      .pipe(Effect.orElseSucceed(() => null));
    if (remote === null) return null;
    const fetchArgs = ["fetch", "--quiet", "--no-tags", "--", remote];
    if ((yield* run("StorageCleanup.fetchRemote", repositoryCwd, fetchArgs)) === null) return null;
    const listed = yield* run("StorageCleanup.listRemoteHeads", repositoryCwd, [
      "ls-remote",
      "--heads",
      "--",
      remote,
    ]);
    return (
      listed
        ?.split("\n")
        .map((line) => line.split("\t")[0] ?? "")
        .filter((sha) => OBJECT_ID.test(sha)) ?? null
    );
  });
  const tipsFor = Effect.fn("StorageCleanup.remoteTips")(function* (repositoryCwd: string) {
    const cached = remoteTips.get(repositoryCwd);
    if (cached !== undefined) return cached;
    const tips = yield* listTips(repositoryCwd);
    remoteTips.set(repositoryCwd, tips);
    return tips;
  });
  return Effect.fn("StorageCleanup.worktreePublished")(function* (input: {
    readonly repositoryCwd: string;
    readonly worktreePath: string;
    readonly headSha: string;
  }) {
    const tips = yield* tipsFor(input.repositoryCwd);
    if (tips === null || tips.length === 0) return false;
    const unpushed = yield* run(
      "StorageCleanup.unpushedCommits",
      input.worktreePath,
      ["rev-list", "--max-count=1", "--ignore-missing", "--stdin", input.headSha],
      `${tips.map((sha) => `^${sha}`).join("\n")}\n`,
    );
    return unpushed !== null && unpushed.trim() === "";
  });
}
