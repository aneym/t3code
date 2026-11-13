import { AgentPlacementReceipt, ModelSelection, ProjectId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const Selection = Schema.Struct({
  placement: AgentPlacementReceipt,
  projectId: Schema.optional(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
});
export type Selection = typeof Selection.Type;

const Saved = Schema.Struct({ savedAt: Schema.Number, selection: Selection });
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 5 * 60 * 1000;

export const make = Effect.fn("PlacementDecisions.make")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const encode = Schema.encodeEffect(Schema.fromJsonString(Saved));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Saved));
  const dir = path.join(stateDir, "agent-placement");
  const fileOf = (key: string) => path.join(dir, `${key}.json`);
  let lastPrunedAt = 0;

  const prune = Effect.fn("PlacementDecisions.prune")(function* (now: number) {
    if (now - lastPrunedAt < PRUNE_EVERY_MS) return;
    lastPrunedAt = now;
    const files = yield* fs.readDirectory(dir);
    yield* Effect.forEach(
      files.filter((file) => /^[a-f0-9]+\.json$/.test(file)),
      (file) =>
        Effect.gen(function* () {
          const filePath = path.join(dir, file);
          const stat = yield* fs.stat(filePath);
          if (Option.isNone(stat.mtime) || now - stat.mtime.value.getTime() > MAX_AGE_MS)
            yield* fs.remove(filePath);
        }).pipe(Effect.ignore),
      { concurrency: 4 },
    );
  });

  const load = (key: string, now: number) =>
    prune(now).pipe(
      Effect.ignore,
      Effect.andThen(fs.readFileString(fileOf(key))),
      Effect.flatMap(decode),
      Effect.map((saved) =>
        saved.savedAt <= now && now - saved.savedAt <= MAX_AGE_MS ? saved.selection : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const save = (key: string, now: number, selection: Selection) =>
    encode({ savedAt: now, selection }).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: fileOf(key), contents })),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
    );

  return { load, save };
});
