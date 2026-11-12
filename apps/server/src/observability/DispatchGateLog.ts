import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { makeNdjsonLogWriter, type NdjsonFields } from "./NdjsonLogWriter.ts";

export type DispatchGateLogWrite = (fields: NdjsonFields) => void;

const MAX_BYTES = 4 * 1024 * 1024;
const discard: DispatchGateLogWrite = () => undefined;

export const makeDispatchGateLog = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  if (Option.isNone(config) || Option.isNone(fileSystem) || Option.isNone(path)) return discard;
  return yield* makeNdjsonLogWriter({
    filePath: path.value.join(config.value.logsDir, "dispatch-gate.ndjson"),
    maxBytes: MAX_BYTES,
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem.value),
    Effect.provideService(Path.Path, path.value),
    Effect.orElseSucceed(() => discard),
  );
});
