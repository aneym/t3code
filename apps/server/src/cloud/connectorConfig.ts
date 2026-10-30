import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const writeConnectorConfig = Effect.fn("ServiceEndpointRuntime.writeConfig")(function* (
  destination: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory: path.dirname(destination), prefix: "connector-config-" }),
        (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.ignore),
      );
      const temporary = path.join(directory, "config");
      yield* fs.writeFileString(temporary, contents, { mode: 0o600 });
      const file = yield* fs.open(temporary, { flag: "r+" });
      yield* file.sync;
      yield* fs.rename(temporary, destination);
    }),
  );
});
