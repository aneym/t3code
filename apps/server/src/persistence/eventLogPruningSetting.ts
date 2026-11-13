import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const PruneEventLogSettings = Schema.fromJsonString(
  Schema.Struct({
    storageCleanup: Schema.optionalKey(
      Schema.Struct({ pruneEventLog: Schema.optionalKey(Schema.Boolean) }),
    ),
  }),
);

export const readPruneEventLogSetting = Effect.fn("readPruneEventLogSetting")(function* (
  databasePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsPath = path.join(path.dirname(databasePath), "settings.json");
  return yield* fs.readFileString(settingsPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PruneEventLogSettings)),
    Effect.map((settings) => settings.storageCleanup?.pruneEventLog === true),
    Effect.orElseSucceed(() => false),
  );
});
