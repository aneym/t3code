// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem has no filesystem-type query.
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeSnapshotDirectory } from "./devDbSnapshotCleanup.ts";

class DevDbSnapshotError extends Schema.TaggedError<DevDbSnapshotError>()("DevDbSnapshotError", {
  sourcePath: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Could not clone source database '${this.sourcePath}': ${this.detail}`;
  }
}

const isDevDbSnapshotError = Schema.is(DevDbSnapshotError);

export const snapshotDevDb = Effect.fn("snapshotDevDb")(
  function* (sourcePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sourceDir = path.dirname(sourcePath);
    const snapshotDir = path.join(
      path.basename(sourceDir) === "userdata" ? path.dirname(sourceDir) : sourceDir,
      "dev-db-snapshots",
    );
    const directory = yield* makeSnapshotDirectory(snapshotDir);
    const snapshotPath = path.join(directory, "statev2.sqlite");
    if (platform === "darwin") {
      const sourceInfo = yield* fs.stat(sourcePath);
      const directoryInfo = yield* fs.stat(directory);
      const [sourceFs, directoryFs] = yield* Effect.tryPromise(() =>
        Promise.all([NodeFSP.statfs(sourcePath), NodeFSP.statfs(directory)]),
      );
      if (sourceInfo.dev !== directoryInfo.dev || sourceFs.type !== 26 || directoryFs.type !== 26) {
        return yield* new DevDbSnapshotError({
          sourcePath,
          detail: "Source snapshots require the same APFS volume",
        });
      }
    }
    const cloneFile = Effect.fn("cloneDevDbFile")(function* (from: string, to: string) {
      const [stderr, exitCode] = yield* spawner
        .spawn(
          ChildProcess.make("cp", [platform === "darwin" ? "-c" : "--reflink=always", from, to], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          }),
        )
        .pipe(
          Effect.flatMap((handle) =>
            Effect.all(
              [
                handle.stderr.pipe(
                  Stream.decodeText(),
                  Stream.runFold(
                    () => "",
                    (tail, chunk) => `${tail}${chunk}`.slice(-4096),
                  ),
                ),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            ),
          ),
          Effect.scoped,
        );
      if (exitCode !== 0) {
        return yield* new DevDbSnapshotError({
          sourcePath,
          detail: stderr.trim() || `Source clone exited ${exitCode}`,
        });
      }
    });
    yield* Effect.acquireUseRelease(
      Effect.try(
        () => new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true, allowExtension: false }),
      ),
      Effect.fn("cloneDevDbSource")(function* (source: NodeSqlite.DatabaseSync) {
        yield* Effect.try(() => {
          source.exec("PRAGMA busy_timeout = 5000; BEGIN");
          source.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
        });
        yield* cloneFile(sourcePath, snapshotPath);
        if (yield* fs.exists(`${sourcePath}-wal`)) {
          yield* cloneFile(`${sourcePath}-wal`, `${snapshotPath}-wal`);
        }
        yield* Effect.try(() => source.exec("COMMIT"));
      }),
      (source) => Effect.sync(() => source.close()),
    ).pipe(Effect.uninterruptible);
    yield* Effect.try(() => {
      const snapshot = new NodeSqlite.DatabaseSync(snapshotPath, { allowExtension: false });
      try {
        const checkpoint = snapshot.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        if (Number(checkpoint?.busy) !== 0) throw new Error("Snapshot WAL is busy");
        const mode = snapshot.prepare("PRAGMA journal_mode=DELETE").get();
        if (mode?.journal_mode !== "delete") throw new Error("Snapshot journal mode is not DELETE");
      } finally {
        snapshot.close();
      }
    });
    yield* Console.log(`Source snapshot ready: ${snapshotPath}`);
    return snapshotPath;
  },
  (effect, sourcePath) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isDevDbSnapshotError(cause)
          ? cause
          : new DevDbSnapshotError({ sourcePath, detail: String(cause) }),
      ),
    ),
);
