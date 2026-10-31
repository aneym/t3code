import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HOT_SWAP_PROTOCOL } from "../serviceLauncherConfig.ts";

export const pinLauncherArtifact = Effect.fn("launcherArtifact.pin")(function* (
  baseDir: string,
  versionDir: string,
  executable: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    baseDir,
    "runtime",
    "launcher-artifacts",
    `hot-swap-${HOT_SWAP_PROTOCOL}`,
  );
  const entry = path.join(directory, path.basename(executable));
  const previous = `${directory}.previous`;
  if (!(yield* fs.exists(directory)) && (yield* fs.exists(previous)))
    yield* fs.rename(previous, directory);
  const old = yield* fs.readFile(entry).pipe(Effect.option);
  const incoming = yield* fs.readFile(executable);
  if (
    Option.isSome(old) &&
    old.value.length === incoming.length &&
    incoming.every((byte, index) => byte === old.value[index])
  )
    return entry;
  const staging = `${directory}.pending`;
  yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
  yield* fs.remove(staging, { recursive: true, force: true });
  if (Option.isSome(old)) yield* fs.copy(directory, staging, { overwrite: true });
  yield* fs.copy(versionDir, staging, { overwrite: true });
  yield* fs.copyFile(
    Option.isSome(old) ? entry : executable,
    path.join(staging, `${path.basename(executable)}.lkg`),
  );
  yield* fs.writeFileString(path.join(staging, ".launcher-complete"), String(HOT_SWAP_PROTOCOL), {
    mode: 0o600,
  });
  yield* fs.remove(previous, { recursive: true, force: true });
  if (yield* fs.exists(directory)) yield* fs.rename(directory, previous);
  yield* fs.rename(staging, directory);
  return entry;
});
