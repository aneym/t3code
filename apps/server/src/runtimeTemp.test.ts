import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { sweepStaleRuntimeTempDirectories } from "./runtimeTemp.ts";
import { acquireServerOwnership } from "./serverOwnership.ts";
import * as ProcessRunner from "./processRunner.ts";

it.effect("startup sweeps only expired owned runtime directories", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1_800_000_000_000);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-temp-test-" });
    const baseDir = path.join(root, "server");
    const tmp = path.join(baseDir, "runtime", "tmp");
    const outside = path.join(root, "t3code-ssh-runtime-outside");
    yield* fs.makeDirectory(tmp, { recursive: true });
    yield* fs.makeDirectory(outside);
    yield* fs.writeFileString(path.join(outside, "keep"), "other server");
    const now = yield* Clock.currentTimeMillis;
    const day = 24 * 60 * 60 * 1000;
    const cases = [
      { name: "t3code-ssh-runtime-expired", age: day + 1000, keep: false },
      { name: "t3-orchestration-v2-replay-expired", age: day + 1000, keep: false },
      { name: "t3code-ssh-runtime-fresh", age: 1000, keep: true },
      { name: "t3-orchestration-v2-replay-fresh", age: 1000, keep: true },
      { name: "t3code-ssh-runtime-boundary", age: day, keep: true },
      { name: "unrelated-expired", age: day + 1000, keep: true },
    ];
    for (const entry of cases) {
      const directory = path.join(tmp, entry.name);
      yield* fs.makeDirectory(directory);
      yield* fs.writeFileString(path.join(directory, "state"), "owned state");
      yield* fs.utimes(directory, (now - entry.age) / 1000, (now - entry.age) / 1000);
    }
    yield* fs.symlink(outside, path.join(tmp, "t3code-ssh-runtime-link"));
    yield* fs.writeFileString(path.join(tmp, "t3code-ssh-runtime-file"), "not a directory");
    yield* fs.utimes(outside, (now - day - 1000) / 1000, (now - day - 1000) / 1000);
    const statePath = path.join(baseDir, "userdata", "server-runtime.json");
    yield* Effect.scoped(acquireServerOwnership(statePath));
    for (const entry of cases) {
      assert.equal(yield* fs.exists(path.join(tmp, entry.name)), true, entry.name);
    }
    yield* sweepStaleRuntimeTempDirectories(baseDir);
    for (const entry of cases) {
      assert.equal(yield* fs.exists(path.join(tmp, entry.name)), entry.keep, entry.name);
    }
    assert.equal(yield* fs.readFileString(path.join(outside, "keep")), "other server");
    assert.equal(yield* fs.readLink(path.join(tmp, "t3code-ssh-runtime-link")), outside);
    assert.equal(yield* fs.exists(path.join(tmp, "t3code-ssh-runtime-file")), true);
    yield* fs.remove(tmp, { recursive: true });
    yield* sweepStaleRuntimeTempDirectories(baseDir);
    assert.equal(yield* fs.exists(tmp), false);
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
