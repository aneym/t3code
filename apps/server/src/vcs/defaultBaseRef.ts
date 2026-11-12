import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "./GitVcsDriver.ts";

const CONVENTIONAL_BRANCHES = ["main", "master"];

export const resolveDefaultBaseRef = Effect.fn("DefaultBaseRef.resolve")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
) {
  const refExists = (revision: string) =>
    git.resolveCommit({ cwd, revision }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const remoteName = yield* git
    .resolvePrimaryRemoteName(cwd)
    .pipe(Effect.orElseSucceed(() => null));
  if (remoteName !== null) {
    const remoteDefault = yield* git
      .resolveDefaultBranchName(cwd, remoteName)
      .pipe(Effect.orElseSucceed(() => null));
    // Fetch does not update a recorded HEAD, so it can outlive the branch it names.
    for (const branch of remoteDefault === null
      ? CONVENTIONAL_BRANCHES
      : [remoteDefault, ...CONVENTIONAL_BRANCHES]) {
      // Launch resolves a bare name through a local branch's upstream, or else assumes `origin`.
      if (yield* refExists(`refs/remotes/${remoteName}/${branch}`))
        return `${remoteName}/${branch}`;
    }
  }
  for (const branch of CONVENTIONAL_BRANCHES) {
    if (yield* refExists(`refs/heads/${branch}`)) return branch;
  }
  return null;
});
