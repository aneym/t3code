import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { makeReplayServerConfig } from "./ProviderReplayHarness.ts";

it.effect("removes replay state after the scenario scope closes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* Effect.scoped(
      Effect.gen(function* () {
        const config = yield* makeReplayServerConfig("temp-cleanup");
        assert.equal(yield* fs.exists(config.stateDir), true);
        yield* fs.writeFileString(config.dbPath, "scenario state");
        return config.baseDir;
      }),
    );
    assert.equal(yield* fs.exists(baseDir), false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
