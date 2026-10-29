import { GitCommandError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

export const WORKTREE_TRASH_FOLDER = ".worktree-trash";
const ADMIN_TRASH_FOLDER = "t3-worktree-trash";
const ENTRY = /^(\d{13})-[^/\\]+\.worktree$/;
const RECOVERY_FAILED = "recovery-failed.txt";
const RETENTION_MS = 86_400_000;

export const makeWorktreeTrash = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const failure = (cwd: string, detail: string) =>
    new GitCommandError({ operation: "WorktreeTrash", command: "rename", cwd, detail });
  const fenced = (trash: string) =>
    fs.realPath(trash).pipe(
      Effect.map((real) => real === trash),
      Effect.orElseSucceed(() => false),
    );

  const prepare = Effect.fn("WorktreeTrash.prepare")(function* (
    root: string,
    worktreePath: string,
  ) {
    const trash = path.join(root, WORKTREE_TRASH_FOLDER);
    yield* fs.makeDirectory(trash, { recursive: true });
    if (!(yield* fenced(trash)))
      return yield* failure(worktreePath, `worktree trash is a link: ${trash}`);
    yield* fs.writeFileString(path.join(trash, ".gitignore"), "*\n");
    const entry = path.join(
      trash,
      `${yield* Clock.currentTimeMillis}-${path.basename(worktreePath)}.worktree`,
    );
    yield* fs.makeDirectory(entry);
    return entry;
  });

  const discard = (entry: string) =>
    fs.readDirectory(entry).pipe(
      Effect.flatMap((names) =>
        names.length === 0 ? fs.remove(entry, { recursive: true }) : Effect.void,
      ),
      Effect.ignore,
    );

  const move = Effect.fn("WorktreeTrash.move")(function* (input: {
    readonly root: string;
    readonly entry: string;
    readonly worktreePath: string;
    readonly adminDir: string;
  }) {
    const commonDir = yield* fs.realPath(
      path.resolve(
        input.adminDir,
        (yield* fs.readFileString(path.join(input.adminDir, "commondir"))).trim(),
      ),
    );
    const adminTrash = path.join(commonDir, ADMIN_TRASH_FOLDER);
    const adminEntry = path.join(adminTrash, path.basename(input.entry));
    const checkout = path.join(input.entry, "checkout");
    const savedAdmin = path.join(adminEntry, "git");
    let stranded = false;
    yield* Effect.acquireUseRelease(
      Effect.succeed({ checkoutMoved: false, adminMoved: false }),
      (state) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const trash = path.join(input.root, WORKTREE_TRASH_FOLDER);
            if (!(yield* fenced(trash)))
              return yield* failure(input.worktreePath, `worktree trash is a link: ${trash}`);
            if ((yield* fs.readFileString(path.join(trash, ".gitignore"))).trim() !== "*")
              return yield* failure(input.worktreePath, `worktree trash is not ignored: ${trash}`);
            yield* fs.makeDirectory(adminTrash, { recursive: true });
            if (!(yield* fenced(adminTrash)))
              return yield* failure(input.worktreePath, `worktree trash is a link: ${adminTrash}`);
            yield* fs.makeDirectory(adminEntry);
            yield* fs.rename(input.worktreePath, checkout);
            state.checkoutMoved = true;
            yield* fs.rename(input.adminDir, savedAdmin);
            state.adminMoved = true;
            const movedAtSeconds = (yield* Clock.currentTimeMillis) / 1000;
            for (const entry of [input.entry, adminEntry])
              yield* fs.utimes(entry, movedAtSeconds, movedAtSeconds);
          }),
        ),
      (state, exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.gen(function* () {
              for (const [moved, from, to] of [
                [state.adminMoved, savedAdmin, input.adminDir],
                [state.checkoutMoved, checkout, input.worktreePath],
              ] as const) {
                if (!moved) continue;
                yield* fs.rename(from, to).pipe(
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      stranded = true;
                      for (const entry of [input.entry, adminEntry])
                        yield* fs
                          .writeFileString(
                            path.join(entry, RECOVERY_FAILED),
                            `Move ${savedAdmin} back to ${input.adminDir}\nMove ${checkout} back to ${input.worktreePath}\n`,
                          )
                          .pipe(Effect.ignore);
                      yield* Effect.logError(
                        "storage cleanup could not restore a trashed worktree",
                        {
                          from,
                          to,
                          error,
                        },
                      );
                    }),
                  ),
                );
              }
            }),
    ).pipe(
      Effect.tapError(() => Effect.all([discard(input.entry), discard(adminEntry)])),
      Effect.mapError((error) =>
        stranded
          ? failure(input.worktreePath, `removal failed and the worktree is in ${checkout}`)
          : error,
      ),
    );
  });

  const purge = Effect.fn("WorktreeTrash.purge")(function* (
    roots: ReadonlyArray<string>,
    now: number,
    projectPaths: ReadonlyArray<string>,
  ) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const locations = new Set(roots.map((root) => path.join(root, WORKTREE_TRASH_FOLDER)));
    for (const cwd of projectPaths) {
      const common = yield* git
        .execute({
          operation: "WorktreeTrash.commonDir",
          cwd,
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        })
        .pipe(
          Effect.flatMap((result) => fs.realPath(result.stdout.trim())),
          Effect.orElseSucceed(() => null),
        );
      if (common !== null) locations.add(path.join(common, ADMIN_TRASH_FOLDER));
    }
    for (const trash of locations) {
      if (!(yield* fs.exists(trash))) continue;
      if (!(yield* fenced(trash))) {
        yield* Effect.logWarning("worktree trash is a link; not purging", { trash });
        continue;
      }
      for (const name of yield* fs.readDirectory(trash)) {
        const stamp = ENTRY.exec(name)?.[1];
        if (stamp === undefined || Number(stamp) >= now - RETENTION_MS) continue;
        const entry = path.join(trash, name);
        if ((yield* fs.realPath(entry)) !== entry) continue;
        const info = yield* fs.stat(entry);
        const modified = Option.getOrNull(info.mtime)?.getTime();
        if (info.type !== "Directory" || modified === undefined || modified >= now - RETENTION_MS)
          continue;
        if (yield* fs.exists(path.join(entry, RECOVERY_FAILED))) continue;
        if (!(yield* fenced(trash))) break;
        yield* fs.remove(entry, { recursive: true });
      }
    }
  });

  return { prepare, discard, move, purge };
});
