import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

const KEPT_NOTICE = /^(?:licen[cs]e|notice|copying)/i;
const RUNTIME_ONLY_DROPPED = /\.(?:d\.[cm]?ts|map|md|markdown)$/i;
const DROPPED_DIRECTORIES = ["zod/src"];

export const stageWebClient = Effect.fn("stageWebClient")(function* (
  source: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.copy(source, target);
  const maps = (yield* fs.readDirectory(target, { recursive: true })).filter((entry) =>
    entry.endsWith(".map"),
  );
  for (const entry of maps) {
    yield* fs.remove(path.join(target, entry), { force: true });
  }
});

/** Nested .bin shims are unused symlinks, which the npm registry rejects in tarballs. */
export const removeNestedBinDirectories = Effect.fn("build-cli-archive.removeNestedBinDirectories")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    root: string,
  ): Effect.fn.Return<void, PlatformError.PlatformError> {
    const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const child = path.join(root, entry);
      if (entry === ".bin") {
        yield* fs.remove(child, { recursive: true, force: true });
        continue;
      }
      const info = yield* fs.stat(child).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") {
        yield* removeNestedBinDirectories(fs, path, child);
      }
    }
  },
);

/** Type declarations, source maps, docs and zod's TypeScript sources never load at runtime. */
export const pruneRuntimeNodeModules = Effect.fn("pruneRuntimeNodeModules")(function* (
  nodeModulesDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let removed = 0;
  for (const directory of DROPPED_DIRECTORIES) {
    yield* fs.remove(path.join(nodeModulesDir, directory), { recursive: true, force: true });
  }
  for (const entry of yield* fs.readDirectory(nodeModulesDir, { recursive: true })) {
    if (!RUNTIME_ONLY_DROPPED.test(entry) || KEPT_NOTICE.test(path.basename(entry))) continue;
    const target = path.join(nodeModulesDir, entry);
    const info = yield* fs.stat(target).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") continue;
    removed += Number(info.value.size);
    yield* fs.remove(target);
  }
  yield* Effect.log(`[cli-archive] Pruned ${removed} bytes of types, maps and docs.`);
});
