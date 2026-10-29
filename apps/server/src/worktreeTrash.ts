import { GitCommandError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** Lives in each managed worktree root so removal is a same-volume rename. */
export const WORKTREE_TRASH_FOLDER = ".worktree-trash";
const ENTRY = /^(\d{13})-[^/\\]+\.worktree$/;
const RECOVERY_FAILED = "recovery-failed.txt";
const RETENTION_MS = 86_400_000;

export const makeWorktreeTrash = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const failure = (cwd: string, detail: string) =>
    new GitCommandError({ operation: "WorktreeTrash", command: "rename", cwd, detail });
  // `root` is canonical; a linked trash folder would let the purge delete wherever it points.
  const fenced = (root: string) =>
    fs.realPath(path.join(root, WORKTREE_TRASH_FOLDER)).pipe(
      Effect.map((real) => real === path.join(root, WORKTREE_TRASH_FOLDER)),
      Effect.orElseSucceed(() => false),
    );

  const prepare = Effect.fn("WorktreeTrash.prepare")(function* (
    root: string,
    worktreePath: string,
  ) {
    const trash = path.join(root, WORKTREE_TRASH_FOLDER);
    yield* fs.makeDirectory(trash, { recursive: true });
    if (!(yield* fenced(root)))
      return yield* failure(worktreePath, `worktree trash is a link: ${trash}`);
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

  // The checkout and Git's admin folder move into the entry; nothing deletes the original path.
  const move = Effect.fn("WorktreeTrash.move")(function* (input: {
    readonly root: string;
    readonly entry: string;
    readonly worktreePath: string;
    readonly adminDir: string;
  }) {
    const checkout = path.join(input.entry, "checkout");
    let stranded = false;
    yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        if (!(yield* fenced(input.root)))
          return yield* failure(input.worktreePath, `worktree trash is a link: ${input.root}`);
        yield* fs.rename(input.worktreePath, checkout);
      }),
      () =>
        fs.rename(input.adminDir, path.join(input.entry, "git")).pipe(
          // Git's admin folder lives with the repository, often on another volume; Git deletes it on removal too.
          Effect.catchIf(
            (error) =>
              error.reason._tag === "Unknown" &&
              (error.reason.cause as { code?: unknown } | undefined)?.code === "EXDEV",
            () => fs.remove(input.adminDir, { recursive: true }),
          ),
        ),
      (_, exit) =>
        exit._tag === "Success"
          ? Effect.void
          : fs.rename(checkout, input.worktreePath).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  stranded = true;
                  yield* fs
                    .writeFileString(
                      path.join(input.entry, RECOVERY_FAILED),
                      `Move ${checkout} back to ${input.worktreePath}\n`,
                    )
                    .pipe(Effect.ignore);
                  yield* Effect.logError("storage cleanup could not restore a trashed worktree", {
                    checkout,
                    worktreePath: input.worktreePath,
                    error,
                  });
                }),
              ),
            ),
    ).pipe(
      Effect.tapError(() => discard(input.entry)),
      Effect.mapError((error) =>
        stranded
          ? failure(input.worktreePath, `removal failed and the worktree is in ${checkout}`)
          : error,
      ),
    );
    const movedAtSeconds = (yield* Clock.currentTimeMillis) / 1000;
    yield* fs.utimes(input.entry, movedAtSeconds, movedAtSeconds);
  });

  const purge = Effect.fn("WorktreeTrash.purge")(function* (
    roots: ReadonlyArray<string>,
    now: number,
  ) {
    for (const root of roots) {
      const trash = path.join(root, WORKTREE_TRASH_FOLDER);
      if (!(yield* fs.exists(trash))) continue;
      if (!(yield* fenced(root))) {
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
        if (!(yield* fenced(root))) break;
        yield* fs.remove(entry, { recursive: true });
      }
    }
  });

  return { prepare, discard, move, purge };
});
