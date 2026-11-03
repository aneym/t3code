import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

export const nestedRepositoryReason = Effect.fn("StorageCleanup.nestedRepositoryReason")(function* (
  cwd: string,
  submodules: ReadonlySet<string>,
  index: string,
  unchecked: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.realPath(cwd);
  const others = yield* git.execute({
    operation: "StorageCleanup.nestedRepositoryPaths",
    cwd,
    args: [
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "--others",
      "--directory",
      "-z",
      "--exclude=node_modules/",
    ],
    maxOutputBytes: 16 * 1024 * 1024,
  });
  if (others.stdoutTruncated || others.stderr.trim() !== "")
    return "nested repository inspection exceeded the limit";
  const directories = new Set<string>();
  const pending = unchecked.filter((directory) => {
    const relative = path.relative(root, directory);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  });
  for (const file of index.split("\0").map((entry) => entry.slice(2))) {
    for (
      let directory = path.dirname(file);
      directory !== ".";
      directory = path.dirname(directory)
    ) {
      const target = path.resolve(root, directory);
      if (directories.has(target)) break;
      directories.add(target);
    }
  }
  for (const file of others.stdout.split("\0").filter(Boolean)) {
    if (file.endsWith("/")) pending.push(path.resolve(root, file));
    for (
      let directory = path.dirname(file);
      directory !== ".";
      directory = path.dirname(directory)
    ) {
      const target = path.resolve(root, directory);
      if (directories.has(target)) break;
      directories.add(target);
    }
  }
  const checked = new Set<string>();
  const inspect = Effect.fn("StorageCleanup.inspectNestedRepository")(function* (
    directory: string,
  ) {
    if (checked.has(directory) || submodules.has(directory)) return null;
    checked.add(directory);
    const canonical = yield* fs.realPath(directory).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
    if (canonical !== directory) return null;
    const repository =
      (yield* fs.exists(path.join(directory, ".git"))) ||
      ((yield* fs.exists(path.join(directory, "HEAD"))) &&
        (yield* fs.exists(path.join(directory, "objects"))) &&
        (yield* fs.exists(path.join(directory, "refs"))));
    return repository ? `has a nested repository (${path.relative(root, directory)}/)` : null;
  });
  for (const directory of directories) {
    const reason = yield* inspect(directory);
    if (reason !== null) return reason;
  }
  let entries = 0;
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (submodules.has(directory) || path.basename(directory) === "node_modules") continue;
    if (++visited > 256) return "nested repository inspection exceeded the limit";
    if ((yield* fs.realPath(directory)) !== directory) continue;
    const reason = yield* inspect(directory);
    if (reason !== null) return reason;
    const names = yield* fs.readDirectory(directory);
    entries += names.length;
    if (entries > 4096) return "nested repository inspection exceeded the limit";
    for (const name of names) {
      if (name === ".git" || name === "node_modules") continue;
      const child = path.join(directory, name);
      const linked = yield* fs.readLink(child).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) =>
            error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL",
          () => Effect.succeed(false),
        ),
      );
      if (!linked && (yield* fs.stat(child)).type === "Directory") pending.push(child);
    }
  }
  return null;
});
