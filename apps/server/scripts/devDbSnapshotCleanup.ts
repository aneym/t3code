// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem has no empty-directory-only removal.
import * as NodeFSP from "node:fs/promises";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { isDevDbProcessAlive } from "./devDbRuntime.ts";

const sweepSnapshots = Effect.fn("sweepDevDbSnapshots")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cutoff = (yield* Clock.currentTimeMillis) - 6 * 60 * 60 * 1000;
  for (const name of yield* fs.readDirectory(directory)) {
    if (!name.startsWith("snapshot-")) continue;
    const candidate = path.join(directory, name);
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    if (
      Option.isNone(info) ||
      info.value.type !== "Directory" ||
      Option.isNone(info.value.mtime) ||
      info.value.mtime.value.getTime() >= cutoff
    ) {
      continue;
    }
    const owner = yield* fs.readFileString(path.join(candidate, "owner.pid")).pipe(Effect.option);
    if (Option.isSome(owner) && isDevDbProcessAlive(Number(owner.value))) continue;
    yield* fs.remove(candidate, { recursive: true });
  }
});

export const makeSnapshotDirectory = Effect.fn("makeDevDbSnapshotDirectory")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* sweepSnapshots(directory);
  const temporary = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ directory, prefix: "snapshot-" }),
    Effect.fn("removeDevDbSnapshotDirectory")(function* (temporary: string) {
      yield* fs.remove(temporary, { recursive: true }).pipe(Effect.orDie);
      yield* Effect.tryPromise(() => NodeFSP.rmdir(directory)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
    }),
  );
  yield* fs.writeFileString(path.join(temporary, "owner.pid"), String(process.pid));
  return temporary;
});
