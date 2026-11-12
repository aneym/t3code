import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { CodexExecutable } from "./CodexInstallation.ts";

export const runCodexCommand = Effect.fn("CodexInstallation.runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolved = yield* resolveSpawnCommand(command, args).pipe(
    Effect.provideService(HostProcess.Platform, platform),
  );
  const child = yield* spawner.spawn(
    ChildProcess.make(resolved.command, resolved.args, { shell: resolved.shell }),
  );
  const [output, , exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.runDrain),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0) return yield* Effect.fail(exitCode);
  return output;
}, Effect.scoped);

const localCache = new Map<string, { fingerprint: string; executable: CodexExecutable | null }>();

export const probeLocalCodex = Effect.fn("CodexInstallation.probeLocal")(
  function* (managedDirectory: string, prewarm = false) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const hasCodeModeHost = Effect.fn("CodexInstallation.hasCodeModeHost")(
      function* (realExecutablePath: string) {
        if (/^(?:volta-shim|mise|aqua-proxy)(?:\.exe)?$/iu.test(path.basename(realExecutablePath)))
          return true;
        if (platform === "win32") {
          if (path.extname(realExecutablePath).toLowerCase() !== ".exe") return true;
          for (const extension of [".bunx", ".shim"]) {
            const marker = yield* fs
              .stat(realExecutablePath.slice(0, -4) + extension)
              .pipe(Effect.option);
            if (
              Option.isSome(marker) &&
              marker.value.type === "File" &&
              Number(marker.value.size) > 0
            )
              return true;
          }
        } else {
          const header = yield* fs.open(realExecutablePath, { flag: "r" }).pipe(
            Effect.flatMap((file) => file.readAlloc(2)),
            Effect.orElseSucceed(() => Option.none()),
          );
          if (Option.isSome(header) && header.value[0] === 0x23 && header.value[1] === 0x21)
            return true;
        }
        const info = yield* fs.stat(
          path.join(
            path.dirname(realExecutablePath),
            `codex-code-mode-host${platform === "win32" ? ".exe" : ""}`,
          ),
        );
        return (
          info.type === "File" &&
          Number(info.size) > 0 &&
          (platform === "win32" || (info.mode & 0o111) !== 0)
        );
      },
      Effect.scoped,
      Effect.orElseSucceed(() => false),
    );

    const executablePath = yield* resolveCommandPath("codex", { env: environment }).pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (executablePath === null) return null;
    const realExecutablePath = yield* fs.realPath(executablePath);
    const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
    if (
      realExecutablePath.startsWith(
        `${Option.getOrElse(realManaged, () => managedDirectory)}${path.sep}`,
      )
    )
      return null;
    if (!(yield* hasCodeModeHost(realExecutablePath))) return null;
    const info = yield* fs.stat(executablePath);
    const fingerprint = `${realExecutablePath}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}:${Option.getOrUndefined(info.ino)}`;
    const cached = localCache.get(executablePath);
    const executable =
      cached?.fingerprint === fingerprint
        ? cached.executable
        : yield* Effect.gen(function* () {
            const output = yield* runCodexCommand(executablePath, ["--version"]);
            const version = /^codex-cli (\d+\.\d+\.\d+)$/u.exec(output.trim())?.[1];
            if (!version) return null;
            yield* runCodexCommand(executablePath, ["app-server", "--help"]);
            return {
              executablePath,
              source: "local",
              version,
              managedVersionDirectory: null,
            } satisfies CodexExecutable;
          }).pipe(
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed(() => null),
          );
    if (executable !== null || !prewarm)
      localCache.set(executablePath, { fingerprint, executable });
    return executable;
  },
  Effect.orElseSucceed(() => null),
);
