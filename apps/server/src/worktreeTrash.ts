import { GitCommandError, type ServerSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { isFilesystemRoot, managedWorktreesDirectories } from "./worktreesDirectory.ts";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

export const WORKTREE_TRASH_FOLDER = ".worktree-trash";
const ADMIN_TRASH_FOLDER = "t3-worktree-trash";
const ENTRY = /^(\d{13})-[^/\\]+\.worktree$/;
const RECOVERY_REQUIRED = "recovery-required";
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
    const parts = [
      { moved: false, from: input.worktreePath, to: path.join(input.entry, "checkout") },
      { moved: false, from: input.adminDir, to: path.join(adminEntry, "git") },
    ];
    const entries = [input.entry, adminEntry];
    const instructions = () =>
      parts
        .filter((part) => part.moved)
        .map((part) => `Move ${part.to} back to ${part.from}`)
        .join("\n");
    yield* Effect.acquireUseRelease(
      Effect.succeed(parts),
      () =>
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
            for (const entry of entries)
              yield* fs.makeDirectory(path.join(entry, RECOVERY_REQUIRED));
            const pending = parts
              .map((part) => `If present, move ${part.to} back to ${part.from}`)
              .join("\n");
            for (const entry of entries)
              yield* fs.writeFileString(path.join(entry, RECOVERY_FAILED), `${pending}\n`);
            for (const part of parts) {
              yield* fs.rename(part.from, part.to);
              part.moved = true;
            }
            const movedAtSeconds = (yield* Clock.currentTimeMillis) / 1000;
            for (const entry of entries) yield* fs.utimes(entry, movedAtSeconds, movedAtSeconds);
          }),
        ),
      (_, exit) =>
        exit._tag === "Success"
          ? Effect.void
          : Effect.gen(function* () {
              for (const part of [...parts].reverse()) {
                if (!part.moved) continue;
                yield* fs.rename(part.to, part.from).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      part.moved = false;
                    }),
                  ),
                  Effect.catch((error) =>
                    Effect.logError("storage cleanup could not restore a trashed worktree", {
                      from: part.to,
                      to: part.from,
                      error,
                    }),
                  ),
                );
              }
              const text = instructions();
              if (text === "") return;
              for (const entry of entries)
                yield* fs
                  .writeFileString(path.join(entry, RECOVERY_FAILED), `${text}\n`)
                  .pipe(
                    Effect.catch((error) =>
                      Effect.logError(
                        "worktree recovery note failed; recovery-required flag retained",
                        { entry, error },
                      ),
                    ),
                  );
            }),
    ).pipe(
      Effect.tapError(() => Effect.forEach(entries, discard, { discard: true })),
      Effect.mapError((error) =>
        instructions() === ""
          ? error
          : failure(input.worktreePath, `removal failed; ${instructions().replaceAll("\n", "; ")}`),
      ),
    );
    for (const entry of entries)
      yield* fs.remove(path.join(entry, RECOVERY_FAILED)).pipe(
        Effect.andThen(fs.remove(path.join(entry, RECOVERY_REQUIRED), { recursive: true })),
        Effect.catch((error) =>
          Effect.logWarning("worktree recovery flag retained after successful move", {
            entry,
            error,
          }),
        ),
      );
  });

  const checkoutStateReason = Effect.fnUntraced(function* (cwd: string) {
    if (yield* fs.exists(path.join(cwd, ".lane"))) return "has excluded local state (.lane/)";
    const git = yield* GitVcsDriver.GitVcsDriver;
    const inspect = (operation: string, args: string[]) =>
      git.execute({ operation, cwd, args, maxOutputBytes: 64 * 1024 });
    const commonDir = yield* inspect("StorageCleanup.commonDir", [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const excludeFile = path.join(commonDir.stdout.trim(), "info", "exclude");
    const patterns = (yield* fs.exists(excludeFile))
      ? (yield* fs.readFileString(excludeFile))
          .split(/\r?\n/)
          .some((line) => line.trim() !== "" && !line.startsWith("#"))
      : false;
    if (patterns) {
      const excluded = yield* inspect("StorageCleanup.excludedFiles", [
        "ls-files",
        "--others",
        "--ignored",
        "--directory",
        "--no-empty-directory",
        "-z",
        `--exclude-from=${excludeFile}`,
      ]);
      if (excluded.stdoutTruncated) return "excluded files exceed the inspection limit";
      const file = excluded.stdout.split("\0").find((entry) => entry !== "");
      if (file !== undefined) return `has excluded local state (${file})`;
    }
    const untracked = yield* inspect("StorageCleanup.untrackedDirectories", [
      "ls-files",
      "--others",
      "--directory",
      "-z",
    ]);
    if (untracked.stdoutTruncated) return "untracked files exceed the inspection limit";
    for (const entry of untracked.stdout.split("\0")) {
      if (entry.endsWith("/") && (yield* fs.exists(path.join(cwd, entry, ".git"))))
        return `has a nested repository (${entry})`;
    }
    return null;
  });

  const personalStateReason = Effect.fn("StorageCleanup.personalStateReason")(function* (
    cwd: string,
  ) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const own = yield* checkoutStateReason(cwd);
    if (own !== null || !(yield* fs.exists(path.join(cwd, ".gitmodules")))) return own;
    const populated = yield* git.execute({
      operation: "StorageCleanup.submodules",
      cwd,
      args: [
        "submodule",
        "foreach",
        "--recursive",
        "--quiet",
        'printf "%s\\0" "$toplevel/$sm_path"',
      ],
      maxOutputBytes: 64 * 1024,
    });
    if (populated.stdoutTruncated) return "submodule inspection exceeded the limit";
    for (const submodule of populated.stdout.split("\0").filter(Boolean)) {
      const reason = yield* checkoutStateReason(submodule);
      if (reason !== null) return `submodule ${reason}`;
    }
    return null;
  });

  const remove = Effect.fn("WorktreeTrash.remove")(function* <E, R>(
    root: string,
    worktreePath: string,
    blocked: () => Effect.Effect<string | null, E, R>,
  ) {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const adminDir = (yield* git.execute({
      operation: "StorageCleanup.adminDir",
      cwd: worktreePath,
      args: ["rev-parse", "--absolute-git-dir"],
    })).stdout.trim();
    if (yield* fs.exists(path.join(adminDir, "locked"))) return "worktree is locked";
    const personal = yield* personalStateReason(worktreePath);
    if (personal !== null) return personal;
    const entry = yield* prepare(root, worktreePath);
    const reason = yield* blocked();
    if (reason !== null) {
      yield* discard(entry);
      return reason;
    }
    yield* move({ root, entry, worktreePath, adminDir });
    return null;
  });

  const managedRoots = Effect.fn("StorageCleanup.managedRoots")(function* (
    serverSettings: ServerSettings,
    defaultDirectory: string,
  ) {
    const roots: Array<string> = [];
    for (const directory of managedWorktreesDirectories(
      serverSettings,
      defaultDirectory,
      path,
      yield* HostProcess.HomeDirectory,
    )) {
      const root = yield* fs.exists(directory).pipe(
        Effect.flatMap((exists) => (exists ? fs.realPath(directory) : Effect.succeed(null))),
        Effect.orElseSucceed(() => null),
      );
      if (root !== null && !isFilesystemRoot(root, path) && !roots.includes(root)) roots.push(root);
    }
    return roots;
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
        if (
          (yield* fs.exists(path.join(entry, RECOVERY_FAILED))) ||
          (yield* fs.exists(path.join(entry, RECOVERY_REQUIRED)))
        )
          continue;
        if (!(yield* fenced(trash))) break;
        yield* fs.remove(entry, { recursive: true });
      }
    }
  });

  return { prepare, discard, move, purge, personalStateReason, remove, managedRoots };
});
