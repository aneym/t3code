import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { requireUnitsServeHome } from "../cloud/bootServiceOwner.ts";
import { bootServiceUnitPath } from "../cloud/bootServiceRender.ts";
import { resolveBaseDir } from "../os-jank.ts";

export const requireServiceServesHome = Effect.fn("cli.service.require_serves_home")(function* (
  baseDirFlag: Option.Option<string>,
) {
  const platform = yield* HostProcess.Platform;
  const homeDir = yield* Config.String("HOME").pipe(Config.withDefault(""));
  if (homeDir === "" || (platform !== "linux" && platform !== "darwin")) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
  const explicit = Option.orElse(baseDirFlag, () => envHome).pipe(
    Option.filter((value) => value.trim().length > 0),
  );
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(explicit));
  yield* requireUnitsServeHome({
    fs,
    path,
    unitPath: bootServiceUnitPath(path.join, platform, homeDir),
    baseDir,
  });
});
