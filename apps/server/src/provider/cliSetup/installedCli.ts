import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { InstalledCli } from "./cliInstallRunner.ts";

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u;

export const readCliVersion = Effect.fn("readCliVersion")(
  function* (executablePath: string, env: NodeJS.ProcessEnv) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(executablePath, ["--version"], { env, extendEnv: false, stdin: "ignore" }),
    );
    const [output, , exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.runDrain),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) return null;
    return output.match(VERSION_PATTERN)?.[0] ?? null;
  },
  Effect.scoped,
  Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.succeed(null) }),
  Effect.orElseSucceed(() => null),
);

export const userCliPath = Effect.fn("userCliPath")(function* (name: string) {
  const path = yield* Path.Path;
  return path.join(yield* HostProcess.HomeDirectory, ".local", "bin", name);
});

export const findInstalledCli = Effect.fn("findInstalledCli")(function* (
  name: "claude" | "codex",
  env: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const onPath = yield* resolveCommandPath(name, { env }).pipe(Effect.orElseSucceed(() => null));
  const candidates = [
    ...(onPath ? [onPath] : []),
    yield* userCliPath(name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const executablePath of new Set(candidates)) {
    if (!(yield* fs.exists(executablePath).pipe(Effect.orElseSucceed(() => false)))) continue;
    const version = yield* readCliVersion(executablePath, env);
    if (version) return { executablePath, version } satisfies InstalledCli;
  }
  return null;
});
