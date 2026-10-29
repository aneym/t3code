import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

export function makeWorktreeIntegrationCheck(git: GitVcsDriver.GitVcsDriver["Service"]) {
  const refreshedDefaultRefs = new Map<string, Set<string>>();
  const defaultBranches = new Map<string, string | null>();
  const contentInDefaultBranch = Effect.fn("StorageCleanup.contentIntegration")(function* (
    cwd: string,
    baseSha: string,
    headSha: string,
  ) {
    const run = (operation: string, args: ReadonlyArray<string>) =>
      git.execute({ operation, cwd, args: [...args], allowNonZeroExit: true }).pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
        Effect.orElseSucceed(() => null),
      );
    const merged = yield* run("StorageCleanup.contentMergeTree", [
      "merge-tree",
      "--write-tree",
      baseSha,
      headSha,
    ]);
    const baseTree = yield* run("StorageCleanup.contentBaseTree", [
      "rev-parse",
      "--verify",
      `${baseSha}^{tree}`,
    ]);
    const mergedTree = merged?.split(/\r?\n/)[0]?.trim();
    return /^[0-9a-f]{40,64}$/.test(mergedTree ?? "") && mergedTree === baseTree;
  });
  return Effect.fn("StorageCleanup.worktreeIntegration")(function* (input: {
    readonly repositoryCwd: string;
    readonly worktreePath: string;
    readonly headSha: string;
    readonly matchContent: boolean;
  }) {
    const { repositoryCwd, worktreePath } = input;
    const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
    const defaultBranchKey = `${repositoryCwd}\0${remote}`;
    let branch = defaultBranches.get(defaultBranchKey);
    if (branch === undefined) {
      branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
      // Without a local HEAD ref, only the remote can identify its default;
      // a conventional name may be a feature branch.
      if (branch === null) {
        branch = yield* git
          .execute({
            operation: "StorageCleanup.resolveDefaultBranch",
            cwd: repositoryCwd,
            args: ["ls-remote", "--symref", "--", remote, "HEAD"],
            timeoutMs: 20_000,
          })
          .pipe(
            Effect.map(
              (result) => /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(result.stdout)?.[1] ?? null,
            ),
            Effect.orElseSucceed(() => null),
          );
      }
      defaultBranches.set(defaultBranchKey, branch);
    }
    if (branch === null) return null;
    const defaultRef = `refs/remotes/${remote}/${branch}`;
    const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
    if (!refreshed.has(defaultRef)) {
      yield* git.fetchRemoteTrackingBranch({
        cwd: repositoryCwd,
        remoteName: remote,
        remoteBranch: branch,
      });
      refreshed.add(defaultRef);
      refreshedDefaultRefs.set(repositoryCwd, refreshed);
    }
    const base = yield* git.resolveCommit({ cwd: worktreePath, revision: defaultRef });
    const ancestor = yield* git.execute({
      operation: "StorageCleanup.integratedBranch",
      cwd: worktreePath,
      args: ["merge-base", "--is-ancestor", input.headSha, base.commitSha],
      allowNonZeroExit: true,
    });
    if (ancestor.exitCode === 0 || !input.matchContent)
      return { defaultBranch: branch, integrated: ancestor.exitCode === 0, byContent: false };
    const byContent = yield* contentInDefaultBranch(worktreePath, base.commitSha, input.headSha);
    return { defaultBranch: branch, integrated: byContent, byContent };
  });
}
