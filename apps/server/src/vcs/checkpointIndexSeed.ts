import * as NodeBuffer from "node:buffer";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

export const checkpointIndexSeedPath = (path: Path.Path, userIndexPath: string) =>
  path.join(path.dirname(userIndexPath), "t3-checkpoint-index");

export const seedScratchIndex = Effect.fn("checkpointIndexSeed.seedScratchIndex")(function* <
  E,
>(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly source: string;
  readonly scratch: string;
  readonly resetToHead: Effect.Effect<unknown, E>;
}) {
  const { fileSystem } = input;
  const { mtime } = yield* fileSystem.stat(input.source);
  if (Option.isNone(mtime)) return false;
  // Stay below the source timestamp even if Date rounded up, preserving Git's racy check.
  const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
  if (indexTime <= 0) return false;
  yield* fileSystem.copyFile(input.source, input.scratch);
  yield* input.resetToHead;
  // read-tree can rewrite the index, so restore its racy timestamp afterward.
  yield* fileSystem.utimes(input.scratch, indexTime, indexTime);
  return true;
});

export const keepCheckpointIndexSeed = (
  fileSystem: FileSystem.FileSystem,
  scratch: string,
  seed: string,
) => fileSystem.rename(scratch, seed).pipe(Effect.ignore);

export const makeIndexFlagScan = (sparseCheckout: boolean) => {
  const state = { specialFlags: false, skippedPaths: [] as string[] };
  let recordStart = true;
  let skipped = false;
  let skippedRecord: Uint8Array[] = [];
  // Only tags and sparse skip-worktree paths matter; scan NUL-delimited records.
  const onStdoutChunk = (chunk: Uint8Array) => {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start);
      if (recordStart) {
        const tag = chunk[start]!;
        skipped = tag === 83;
        if ((tag >= 97 && tag <= 122) || (!sparseCheckout && tag === 83)) {
          state.specialFlags = true;
        }
      }
      if (skipped && sparseCheckout) {
        skippedRecord.push(Buffer.from(chunk.subarray(start, end === -1 ? undefined : end)));
        if (end !== -1) {
          const record = Buffer.concat(skippedRecord);
          if (record.at(-1) !== 47) {
            const name = record.subarray(2);
            if (!NodeBuffer.isUtf8(name)) state.specialFlags = true;
            else state.skippedPaths.push(name.toString("utf8"));
          }
          skippedRecord = [];
        }
      }
      recordStart = end !== -1;
      if (!recordStart) break;
      start = end + 1;
    }
  };
  return { state, onStdoutChunk };
};
