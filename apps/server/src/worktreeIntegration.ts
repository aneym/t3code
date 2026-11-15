import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

export type WorktreeIntegration =
  | { readonly status: "no-remote" }
  | { readonly status: "unavailable"; readonly remote: string | null }
  | {
      readonly status: "resolved";
      readonly remote: string | null;
      readonly defaultBranch: string;
      readonly integrated: boolean;
      readonly byPatch: boolean;
    };

export function makeWorktreeIntegrationCheck(git: GitVcsDriver.GitVcsDriver["Service"]) {
  const refreshedDefaultRefs = new Map<string, Set<string>>();
  const defaultBranches = new Map<string, string | null>();

  const remoteDefaultBranch = Effect.fn("StorageCleanup.remoteDefaultBranch")(function* (
    repositoryCwd: string,
    remote: string,
  ) {
    const key = `${repositoryCwd}\0${remote}`;
    const cached = defaultBranches.get(key);
    if (cached !== undefined) return cached;
    let branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
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
    defaultBranches.set(key, branch);
    return branch;
  });

  const landedByPatch = Effect.fn("StorageCleanup.patchIntegration")(function* (
    cwd: string,
    baseSha: string,
    headSha: string,
  ) {
    const cherry = yield* git
      .execute({
        operation: "StorageCleanup.cherry",
        cwd,
        args: ["cherry", baseSha, headSha],
        allowNonZeroExit: true,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (cherry === null || cherry.exitCode !== 0 || cherry.stdoutTruncated) return false;
    const lines = cherry.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
    return lines.length > 0 && lines.every((line) => line.startsWith("- "));
  });

  return Effect.fn("StorageCleanup.worktreeIntegration")(function* (input: {
    readonly repositoryCwd: string;
    readonly worktreePath: string;
    readonly headSha: string;
    readonly localDefault: boolean;
    readonly matchPatches: boolean;
  }) {
    const { repositoryCwd } = input;
    const remotes = yield* git.execute({
      operation: "StorageCleanup.listRemotes",
      cwd: repositoryCwd,
      args: ["remote"],
    });
    const remote =
      remotes.stdout.trim() === "" ? null : yield* git.resolvePrimaryRemoteName(repositoryCwd);
    let branch: string | null;
    let defaultRef: string;
    if (remote === null) {
      if (!input.localDefault) return { status: "no-remote" } as const;
      const projectHead = yield* git.execute({
        operation: "StorageCleanup.resolveProjectBranch",
        cwd: repositoryCwd,
        args: ["symbolic-ref", "--quiet", "HEAD"],
        allowNonZeroExit: true,
      });
      if (projectHead.exitCode !== 0) return { status: "unavailable", remote } as const;
      defaultRef = projectHead.stdout.trim();
      branch = defaultRef.slice("refs/heads/".length);
    } else {
      branch = yield* remoteDefaultBranch(repositoryCwd, remote);
      if (branch === null) return { status: "unavailable", remote } as const;
      defaultRef = `refs/remotes/${remote}/${branch}`;
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
    }
    const base = yield* git.resolveCommit({ cwd: input.worktreePath, revision: defaultRef });
    const ancestor = yield* git.execute({
      operation: "StorageCleanup.integratedBranch",
      cwd: input.worktreePath,
      args: ["merge-base", "--is-ancestor", input.headSha, base.commitSha],
      allowNonZeroExit: true,
    });
    const byPatch =
      ancestor.exitCode !== 0 &&
      input.matchPatches &&
      (yield* landedByPatch(input.worktreePath, base.commitSha, input.headSha));
    return {
      status: "resolved",
      remote,
      defaultBranch: branch,
      integrated: ancestor.exitCode === 0 || byPatch,
      byPatch,
    } as const;
  });
}
