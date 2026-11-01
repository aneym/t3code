import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

export const inspectWorktreeSubmodules = Effect.fn("StorageCleanup.inspectSubmodules")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const isWindows = yield* HostProcess.isWindows;
  const root = yield* fs.realPath(cwd);
  const paths: string[] = [];
  const unchecked: string[] = [];
  const repositories = [root];
  let inspected = 0;
  while (repositories.length > 0) {
    const repository = repositories.pop()!;
    const index = yield* git.execute({
      operation: "StorageCleanup.submodules",
      cwd: repository,
      args: ["ls-files", "--stage", "-z"],
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (index.stdoutTruncated || index.stderrTruncated)
      return "submodule inspection exceeded the limit";
    for (const entry of index.stdout.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      if (++inspected > 10_000) return "submodule inspection exceeded the limit";
      const submodule = path.resolve(repository, entry.slice(entry.indexOf("\t") + 1));
      const relative = path.relative(
        isWindows ? root.toLowerCase() : root,
        isWindows ? submodule.toLowerCase() : submodule,
      );
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        return "submodules could not be inspected";
      if (!(yield* fs.exists(submodule))) continue;
      if ((yield* fs.realPath(submodule)) !== submodule) return "submodules could not be inspected";
      if (!(yield* fs.exists(path.join(submodule, ".git")))) {
        unchecked.push(submodule);
        continue;
      }
      paths.push(submodule);
      repositories.push(submodule);
    }
  }
  return { paths, unchecked };
});
