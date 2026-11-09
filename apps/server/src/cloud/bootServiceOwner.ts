import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { connectorUnitPath } from "../serviceConnectorUnit.ts";
import { bootServiceBaseDirOf } from "./bootServiceRender.ts";

export class BootServiceOtherHomeError extends Schema.TaggedError<BootServiceOtherHomeError>()(
  "BootServiceOtherHomeError",
  {
    unitPath: Schema.String,
    installedBaseDir: Schema.optional(Schema.String),
    baseDir: Schema.String,
  },
) {
  override get message(): string {
    return `Refusing to uninstall: ${this.unitPath} belongs to the T3 home ${this.installedBaseDir ?? "(unknown)"}, not ${this.baseDir}.`;
  }
}

export function unitServesHome(path: Path.Path, unit: string, baseDir: string): boolean {
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
    for (const owned of [input.unitPath, connectorUnitPath(input.unitPath)]) {
      const unit = yield* input.fs.readFileString(owned).pipe(Effect.option);
      if (Option.isSome(unit) && !unitServesHome(input.path, unit.value, input.baseDir)) {
        return yield* new BootServiceOtherHomeError({
          unitPath: owned,
          installedBaseDir: bootServiceBaseDirOf(unit.value),
          baseDir: input.baseDir,
        });
      }
    }
  },
);
