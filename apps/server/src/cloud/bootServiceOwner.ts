import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import { cliRefusal } from "../cliRefusal.ts";
import { serviceUnitBaseDirOf as bootServiceBaseDirOf } from "./serviceProtocol.ts";

export class BootServiceOtherHomeError extends Schema.TaggedError<BootServiceOtherHomeError>()(
  "BootServiceOtherHomeError",
  {
    unitPath: Schema.String,
    installedBaseDir: Schema.optional(Schema.String),
    baseDir: Schema.String,
  },
) {
  override readonly [Runtime.errorReported] = false;
  readonly [cliRefusal] = true;
  override get message(): string {
    const owner = this.installedBaseDir ?? "another T3 home";
    return `Refusing to change ${this.unitPath}: it serves the T3 home ${owner}, not ${this.baseDir}. Run the command with --base-dir ${owner} to manage it, or set T3CODE_SERVICE_NAME to give ${this.baseDir} its own service.`;
  }
}

function unitServesHome(path: Path.Path, unit: string, baseDir: string): boolean {
  const installedBaseDir = bootServiceBaseDirOf(unit);
  return installedBaseDir !== undefined && path.resolve(installedBaseDir) === path.resolve(baseDir);
}

export const requireUnitsServeHome = Effect.fn("cloud.boot_service_owner.require")(
  function* (input: {
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly unitPath: string;
    readonly baseDir: string;
  }) {
    const unit = yield* input.fs.readFileString(input.unitPath).pipe(Effect.option);
    if (Option.isSome(unit) && !unitServesHome(input.path, unit.value, input.baseDir)) {
      return yield* new BootServiceOtherHomeError({
        unitPath: input.unitPath,
        installedBaseDir: bootServiceBaseDirOf(unit.value),
        baseDir: input.baseDir,
      });
    }
  },
);
