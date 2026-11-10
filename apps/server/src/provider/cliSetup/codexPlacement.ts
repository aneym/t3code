// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { cliInstallationError, type InstalledCli } from "./cliInstallRunner.ts";
import { readCliVersion } from "./installedCli.ts";
import type { CodexRelease } from "./codexRelease.ts";

const EXECUTABLES = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "bin/codex-exec-server",
  "codex-path/rg",
  "codex-resources/bwrap",
];

const selectionId = (linkPath: string) => {
  const info = NodeFS.lstatSync(linkPath, { bigint: true });
  const seconds = info.ctimeNs / 1_000_000_000n;
  const nanos = (info.ctimeNs % 1_000_000_000n).toString().padStart(9, "0");
  return `${info.dev} ${info.ino} ${seconds}.${nanos}`;
};

export const placeCodexRelease = Effect.fn("placeCodexRelease")(function* (options: {
  readonly release: CodexRelease;
  readonly archivePath: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const env = options.environment;
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const binDir = env.CODEX_INSTALL_DIR?.trim() || path.join(home, ".local", "bin");
  const standalone = path.join(codexHome, "packages", "standalone");
  const releasesDir = path.join(standalone, "releases");
  const releaseDir = path.join(releasesDir, options.release.releaseName);
  const currentLink = path.join(standalone, "current");
  const isComplete = Effect.gen(function* () {
    for (const relative of ["codex-package.json", "bin/codex", "codex-path/rg"])
      if (!(yield* fs.exists(path.join(releaseDir, relative)))) return false;
    const version = yield* readCliVersion(path.join(releaseDir, "bin", "codex"), env);
    return version === options.release.version;
  });
  const replaceLink = (linkPath: string, target: string, tmpPath: string) =>
    fs
      .remove(tmpPath, { force: true })
      .pipe(
        Effect.andThen(fs.symlink(target, tmpPath)),
        Effect.andThen(fs.rename(tmpPath, linkPath)),
      );
  const writeAtomic = (file: string, content: string) =>
    fs
      .writeFileString(`${file}.tmp.${process.pid}`, content)
      .pipe(Effect.andThen(fs.rename(`${file}.tmp.${process.pid}`, file)));

  if (!(yield* isComplete)) {
    const staging = path.join(
      releasesDir,
      `.staging.${options.release.releaseName}.${process.pid}`,
    );
    yield* fs.remove(staging, { recursive: true, force: true });
    yield* fs.makeDirectory(staging, { recursive: true });
    const tar = yield* spawner.spawn(
      ChildProcess.make("tar", ["-xzf", options.archivePath, "-C", staging], {
        env,
        extendEnv: false,
        stdin: "ignore",
      }),
    );
    const [, , exitCode] = yield* Effect.all(
      [tar.stdout.pipe(Stream.runDrain), tar.stderr.pipe(Stream.runDrain), tar.exitCode],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* cliInstallationError("extract", "Could not unpack the Codex package.");
    for (const relative of EXECUTABLES) {
      const file = path.join(staging, relative);
      if (yield* fs.exists(file)) yield* fs.chmod(file, 0o755);
    }
    yield* fs.symlink("bin/codex", path.join(staging, "codex"));
    yield* fs.remove(releaseDir, { recursive: true, force: true });
    yield* fs.rename(staging, releaseDir);
    if (!(yield* isComplete))
      return yield* cliInstallationError(
        "verify",
        `The unpacked Codex does not report version ${options.release.version}.`,
      );
  }

  const selected = yield* fs.realPath(releaseDir);
  const previous = yield* fs.realPath(currentLink).pipe(Effect.orElseSucceed(() => ""));
  if (previous !== selected) {
    yield* replaceLink(currentLink, releaseDir, path.join(standalone, `.current.${process.pid}`));
    yield* writeAtomic(
      path.join(standalone, "selection-history"),
      `${options.release.releaseName}\n${path.basename(previous)}\n${selectionId(currentLink)}\n`,
    );
  }
  yield* writeAtomic(path.join(standalone, "auto-update-version"), options.release.releaseName);
  yield* fs.makeDirectory(binDir, { recursive: true });
  const executablePath = path.join(binDir, "codex");
  const tmpLink = path.join(binDir, `.codex.${process.pid}`);
  yield* replaceLink(executablePath, path.join(currentLink, "bin", "codex"), tmpLink);
  if (platform === "darwin")
    yield* replaceLink(
      path.join(binDir, "codex-code-mode-host"),
      path.join(currentLink, "bin", "codex-code-mode-host"),
      tmpLink,
    );
  const version = yield* readCliVersion(executablePath, env);
  if (version !== options.release.version)
    return yield* cliInstallationError("verify", "The installed Codex command does not start.");
  return { executablePath, version } satisfies InstalledCli;
});
