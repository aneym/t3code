import {
  ServerImportRestartHandoffInput,
  ServerImportRestartHandoffError,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as Path from "effect/Path";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";

export const importRestartManifest = Effect.gen(function* () {
  const file = yield* Config.option(Config.String("T3CODE_RESTART_HANDOFF_FILE"));
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const paths = yield* Path.Path;
  const manifestPath = Option.getOrElse(file, () =>
    paths.join(config.stateDir, "restart-handoff.json"),
  );
  if (Option.isNone(file) && !(yield* fs.exists(manifestPath))) return;
  const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
  const input = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ServerImportRestartHandoffInput))),
    );
  const result = yield* recovery.importRestartHandoff(input);
  yield* fs.remove(manifestPath);
  yield* Effect.logInfo("Restart handoff imported before runtime recovery", {
    epoch: result.epoch,
    threads: result.threads.length,
  });
}).pipe(Effect.mapError((cause) => new ServerImportRestartHandoffError({ cause })));
