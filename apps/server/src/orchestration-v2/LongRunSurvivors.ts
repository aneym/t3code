import type { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";

export interface SurvivingLongRun {
  readonly name: string;
  readonly log: string;
}

const LongRunRecord = Schema.Struct({
  name: Schema.String,
  log: Schema.String,
  threadId: Schema.optional(Schema.NullOr(Schema.String)),
  kind: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
});
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(LongRunRecord));

const MAX_RECORDS = 200;

/** Reads `long-run` records (claude-config bin/long-run), which outlive a T3 restart. */
export class LongRunSurvivors extends Context.Reference<{
  readonly forThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<SurvivingLongRun>>;
}>("t3/orchestration-v2/LongRunSurvivors", {
  defaultValue: () => ({ forThread: () => Effect.succeed([]) }),
}) {}

export const layer = Layer.effect(
  LongRunSurvivors,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const environment = yield* HostProcess.Environment;
    const stateHome =
      environment.XDG_STATE_HOME || path.join(yield* HostProcess.HomeDirectory, ".local", "state");
    const directory = path.join(stateHome, "long-run");

    const activeUnits = (units: ReadonlyArray<string>) =>
      units.length === 0
        ? Effect.succeed(new Set<string>())
        : runner
            .run({
              command: "systemctl",
              args: ["--user", "is-active", ...units],
              timeout: "5 seconds",
            })
            .pipe(
              Effect.map((result) => {
                const states = result.stdout.split("\n");
                return new Set(
                  units.filter((_, index) =>
                    ["active", "activating", "deactivating"].includes(states[index]?.trim() ?? ""),
                  ),
                );
              }),
            );

    const forThread = Effect.fn("LongRunSurvivors.forThread")(
      function* (threadId: ThreadId) {
        const names = (yield* fileSystem.readDirectory(directory))
          .filter((name) => name.endsWith(".json"))
          .slice(0, MAX_RECORDS);
        const records = [];
        for (const name of names) {
          const record = decodeRecord(
            yield* fileSystem
              .readFileString(path.join(directory, name))
              .pipe(Effect.orElseSucceed(() => "")),
          );
          if (Option.isSome(record) && record.value.threadId === threadId)
            records.push(record.value);
        }
        const units = yield* activeUnits(
          records.flatMap((record) =>
            record.kind === "systemd" ? [record.unit ?? `bg-${record.name}.service`] : [],
          ),
        );
        return records
          .filter((record) =>
            record.kind === "systemd"
              ? units.has(record.unit ?? `bg-${record.name}.service`)
              : record.pid !== undefined && isProcessAlive(record.pid),
          )
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .map((record) => ({ name: record.name, log: record.log }));
      },
      Effect.orElseSucceed((): ReadonlyArray<SurvivingLongRun> => []),
    );

    return { forThread };
  }),
);
