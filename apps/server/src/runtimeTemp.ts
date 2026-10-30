import { SSH_RUNTIME_TEMP_PREFIX } from "@t3tools/ssh/auth";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { REPLAY_RUNTIME_TEMP_PREFIX } from "./orchestration-v2/testkit/replayTemp.ts";

export const sweepStaleRuntimeTempDirectories = Effect.fn("sweepStaleRuntimeTempDirectories")(
  function* (baseDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(baseDir, "runtime", "tmp");
    const cutoff = (yield* Clock.currentTimeMillis) - 24 * 60 * 60 * 1000;
    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
    );
    for (const name of entries) {
      if (
        !name.startsWith(SSH_RUNTIME_TEMP_PREFIX) &&
        !name.startsWith(REPLAY_RUNTIME_TEMP_PREFIX)
      ) {
        continue;
      }
      yield* Effect.gen(function* () {
        const target = path.join(directory, name);
        if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) return;
        const info = yield* fs.stat(target);
        if (
          info.type === "Directory" &&
          Option.isSome(info.mtime) &&
          info.mtime.value.getTime() < cutoff
        ) {
          yield* fs.remove(target, { recursive: true });
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to remove stale runtime temp directory", { name, cause }),
        ),
      );
    }
  },
  Effect.catch((cause) => Effect.logWarning("Failed to sweep runtime temp directories", { cause })),
);
