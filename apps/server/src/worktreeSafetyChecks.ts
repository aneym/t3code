import { GitCommandError, type WorktreeCleanupRules } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { PENDING_OPERATIONS } from "./worktreeTrash.ts";

export const makeWorktreeSafetyChecks = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const isWindows = yield* HostProcess.isWindows;
  const pathKey = (target: string) =>
    isWindows ? path.resolve(target).toLowerCase() : path.resolve(target);
  const inside = (root: string, target: string) => {
    const relative = path.relative(pathKey(root), pathKey(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const branchChanged = Effect.fn("StorageCleanup.branchChanged")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const failure = (detail: string) =>
      new GitCommandError({
        operation: "StorageCleanup.branchChanged",
        command: "git",
        cwd,
        detail,
      });
    const read = Effect.fnUntraced(function* (args: string[], allowedExitCode?: number) {
      const result = yield* git
        .execute({
          operation: "StorageCleanup.branchChanged",
          cwd,
          args,
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(cwd), (exists) =>
              exists ? Effect.fail(error) : Effect.succeed(null),
            ),
          ),
        );
      if (result === null) return null;
      if (result.exitCode === 0 || result.exitCode === allowedExitCode) return result;
      if (/not a git repository|gitfile does not point to a valid repository/i.test(result.stderr))
        return null;
      return yield* failure(
        result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 1000) || "command failed",
      );
    });
    const index = yield* read(["rev-parse", "--git-path", "index"]);
    if (index === null) return true;
    if (yield* fs.exists(`${path.resolve(cwd, index.stdout.trim())}.lock`))
      return yield* failure(
        "Git index is locked. Status will resume when the index lock is removed.",
      );
    const head = yield* read(["symbolic-ref", "--quiet", "HEAD"], 1);
    if (head === null) return true;
    const ref = head.exitCode === 0 ? head.stdout.trim() : "";
    const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length).trim() : null;
    return (name?.startsWith("(") ? null : name) !== branch;
  });

  const localChangesReason = Effect.fn("StorageCleanup.localChangesReason")(function* (
    cwd: string,
    rules: WorktreeCleanupRules,
  ) {
    const status = yield* git.execute({
      operation: "StorageCleanup.localChanges",
      cwd,
      args: [
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--ignore-submodules=none",
        rules.worktreeKeepWhen === "tracked-changes"
          ? "--untracked-files=no"
          : "--untracked-files=all",
      ],
      maxOutputBytes: 64 * 1024,
    });
    if (status.stdoutTruncated) return "local changes exceed the inspection limit";
    const records = status.stdout.split("\0").filter(Boolean);
    let count = 0;
    for (let i = 0; i < records.length; i++) {
      count++;
      if (/^[RC]|^.[RC]/.test(records[i]!)) i++;
    }
    if (count > 0) return `has uncommitted changes (${count} ${count === 1 ? "file" : "files"})`;
    if (rules.worktreeKeepWhen !== "any-local-files") return null;
    const ignored = yield* git.execute({
      operation: "StorageCleanup.ignoredFiles",
      cwd,
      args: [
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      maxOutputBytes: 64 * 1024,
    });
    if (ignored.stdoutTruncated) return "ignored files exceed the inspection limit";
    const file = ignored.stdout
      .split("\0")
      .find((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry));
    return file === undefined ? null : `has ignored files (${file})`;
  });

  const submoduleKeepReason = Effect.fn("StorageCleanup.submoduleKeepReason")(
    function* (cwd: string, rules: WorktreeCleanupRules) {
      const inspect = (args: string[], maxOutputBytes = 64 * 1024) =>
        git.execute({
          operation: "StorageCleanup.submodules",
          cwd,
          args,
          maxOutputBytes,
        });
      const admin = yield* inspect(["rev-parse", "--absolute-git-dir"]);
      if (admin.stdoutTruncated || admin.stderrTruncated)
        return "submodule inspection exceeded the limit";
      const modules = path.join(admin.stdout.replace(/\n$/, ""), "modules");
      const populated = yield* inspect([
        "submodule",
        "foreach",
        "--recursive",
        "--quiet",
        'printf "%s\\0" "$toplevel/$sm_path"',
      ]);
      if (populated.stdoutTruncated || populated.stderrTruncated)
        return "submodule inspection exceeded the limit";
      const paths = populated.stdout.split("\0").filter(Boolean);
      const pending = [modules];
      for (const submodule of paths) {
        const directory = yield* inspect(["-C", submodule, "rev-parse", "--absolute-git-dir"]);
        if (directory.stdoutTruncated || directory.stderrTruncated)
          return "submodule inspection exceeded the limit";
        pending.push(directory.stdout.replace(/\n$/, ""));
      }
      const visited = new Set<string>();
      while (pending.length > 0) {
        const directory = pending.pop()!;
        if (!(yield* fs.exists(directory))) continue;
        const canonical = yield* fs.realPath(directory);
        if (visited.has(canonical)) continue;
        visited.add(canonical);
        if (visited.size > 10_000) return "submodule inspection exceeded the limit";
        if ((yield* fs.stat(directory)).type !== "Directory")
          return "submodule repository could not be inspected";
        if (yield* fs.exists(path.join(directory, "HEAD"))) {
          for (const operation of PENDING_OPERATIONS)
            if (yield* fs.exists(path.join(directory, operation)))
              return `submodule has a Git operation in progress (${operation})`;
          if (yield* fs.exists(path.join(directory, "info", "grafts")))
            return "submodule repository has grafts";
          const replaced = yield* inspect([
            "--git-dir",
            directory,
            "for-each-ref",
            "--count=1",
            "refs/replace/",
          ]);
          if (replaced.stdoutTruncated || replaced.stdout.trim() !== "")
            return "submodule repository has replace refs";
          const linked = path.join(directory, "worktrees");
          if ((yield* fs.exists(linked)) && (yield* fs.readDirectory(linked)).length > 0)
            return "submodule has another linked worktree";
          const unpushed = yield* inspect([
            "--git-dir",
            directory,
            "--work-tree",
            cwd,
            "rev-list",
            "--max-count=1",
            "HEAD",
            "--all",
            "--reflog",
            "--not",
            "--remotes",
          ]);
          if (unpushed.stdoutTruncated || unpushed.stderrTruncated)
            return "submodule inspection exceeded the limit";
          if (unpushed.stdout.trim() !== "")
            return "submodule has commits not on a remote-tracking ref";
          pending.push(path.join(directory, "modules"));
        } else {
          for (const name of yield* fs.readDirectory(directory))
            pending.push(path.join(directory, name));
        }
      }
      for (const submodule of paths) {
        const changes = yield* localChangesReason(submodule, rules);
        if (changes !== null) return `submodule ${changes}`;
      }
      const root = yield* fs.realPath(cwd);
      const populatedPaths = new Set(paths.map(pathKey));
      const unchecked: string[] = [];
      for (const repository of [root, ...paths]) {
        const index = yield* inspect(
          ["-C", repository, "ls-files", "--stage", "-z"],
          16 * 1024 * 1024,
        );
        if (index.stdoutTruncated || index.stderrTruncated)
          return "submodule inspection exceeded the limit";
        for (const entry of index.stdout.split("\0")) {
          if (!entry.startsWith("160000 ")) continue;
          const submodule = path.resolve(repository, entry.slice(entry.indexOf("\t") + 1));
          if (!inside(root, submodule)) return "submodules could not be inspected";
          if (!populatedPaths.has(pathKey(submodule)) && (yield* fs.exists(submodule)))
            unchecked.push(submodule);
        }
      }
      let inspected = unchecked.length;
      while (unchecked.length > 0) {
        if (inspected > 10_000) return "submodule inspection exceeded the limit";
        const target = unchecked.pop()!;
        if (
          (yield* fs.realPath(target)) !== path.resolve(target) ||
          (yield* fs.stat(target)).type !== "Directory"
        )
          return "submodule has local files";
        if (path.basename(target) === "node_modules") continue;
        const names = yield* fs.readDirectory(target);
        inspected += names.length;
        for (const name of names) unchecked.push(path.join(target, name));
      }
      return null;
    },
    Effect.orElseSucceed(() => "submodules could not be inspected"),
  );

  return { branchChanged, localChangesReason, submoduleKeepReason };
});
