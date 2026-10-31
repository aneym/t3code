import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { BootServiceManager, BootServicePlan } from "./bootService.ts";
import { HOT_SWAP_PROTOCOL } from "../serviceLauncherConfig.ts";

export const bootServiceUnitCurrent = Effect.fn("bootServiceComparison.current")(function* (
  manager: BootServiceManager,
  unit: string,
  plan: BootServicePlan,
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expected = (yield* fs.exists(path.join(baseDir, "runtime", "launcher-config.json")))
    ? {
        ...plan,
        program: [
          path.join(
            baseDir,
            "runtime",
            "launcher-artifacts",
            `hot-swap-${HOT_SWAP_PROTOCOL}`,
            path.basename(plan.program[0]!),
          ),
          "__service-launcher-watchdog",
        ],
      }
    : plan;
  const normalize = (text: string) =>
    manager.kind === "launchd"
      ? text.replace(/(<key>PATH<\/key>\n\s*<string>)[^<]*(<\/string>)/, "$1$2")
      : text;
  return normalize(unit) === normalize(manager.render(expected));
});
