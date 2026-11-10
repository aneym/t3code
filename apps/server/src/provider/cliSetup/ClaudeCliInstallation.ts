import { ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  cliInstallationError,
  makeCliInstallRunner,
  type CliInstallUpdate,
} from "./cliInstallRunner.ts";
import { findInstalledCli, readCliVersion, userCliPath } from "./installedCli.ts";

const INSTALLER_URL = "https://claude.ai/install.sh";
const RELEASES_URL = "https://downloads.claude.ai/claude-code-releases";
const DOWNLOAD_NAME = /^claude-(\d+\.\d+\.\d+[^-]*)-([a-z0-9-]+?)(\.zst)?$/u;
const VERSION = /^\d+\.\d+\.\d+/u;
const Manifest = Schema.Struct({
  platforms: Schema.Record(Schema.String, Schema.Struct({ size: Schema.Number })),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const ANSI = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, "gu");

const lastLine = (output: string) =>
  output
    .replace(ANSI, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1)
    ?.slice(0, 300);

export const makeClaudeCliInstallation = Effect.fn("makeClaudeCliInstallation")(function* () {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const context = Context.pick(
    FileSystem.FileSystem,
    Path.Path,
    ChildProcessSpawner.ChildProcessSpawner,
  )(
    yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >(),
  );
  const downloadsDir = path.join(home, ".claude", "downloads");
  const fetchText = (url: string) =>
    http.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeout("60 seconds"),
      Effect.mapError((cause) =>
        cliInstallationError(
          "download",
          "Could not reach Anthropic's download service. Check the internet connection, then try again.",
          cause,
        ),
      ),
    );
  const sizes = new Map<string, number>();
  const sizeOf = Effect.fn("ClaudeCliInstallation.sizeOf")(function* (
    version: string,
    platform: string,
    compressed: boolean,
  ) {
    const key = `${version}/${platform}/${compressed}`;
    const known = sizes.get(key);
    if (known !== undefined) return known;
    const manifest = yield* fetchText(
      `${RELEASES_URL}/${version}/${compressed ? "manifest.zst.json" : "manifest.json"}`,
    ).pipe(Effect.flatMap(decodeManifest), Effect.option);
    if (manifest._tag === "None") return null;
    const size = manifest.value.platforms[platform]?.size;
    if (size === undefined) return null;
    sizes.set(key, size);
    return size;
  });
  const readDownload = Effect.gen(function* () {
    const names = yield* fs.readDirectory(downloadsDir).pipe(Effect.orElseSucceed(() => []));
    for (const name of names.toSorted(
      (a, b) => Number(b.endsWith(".zst")) - Number(a.endsWith(".zst")),
    )) {
      const match = DOWNLOAD_NAME.exec(name);
      if (!match?.[1] || !match[2]) continue;
      const info = yield* fs.stat(path.join(downloadsDir, name)).pipe(Effect.option);
      if (info._tag === "None") continue;
      return {
        downloadedBytes: Number(info.value.size),
        totalBytes: yield* sizeOf(match[1], match[2], match[3] !== undefined),
      };
    }
    return null;
  });
  const watchProgress = Effect.fn("ClaudeCliInstallation.watchProgress")(function* (
    update: CliInstallUpdate,
  ) {
    let reported = -1;
    while (true) {
      const download = yield* readDownload;
      if (download && download.downloadedBytes !== reported) {
        reported = download.downloadedBytes;
        if (download.totalBytes !== null && download.downloadedBytes >= download.totalBytes)
          return yield* update({ ...download, phase: "extracting", message: "Setting up Claude." });
        yield* update(download);
      }
      yield* Effect.sleep("500 millis");
    }
  });

  const install = Effect.fn("ClaudeCliInstallation.install")(function* (update: CliInstallUpdate) {
    const version = (yield* fetchText(`${RELEASES_URL}/latest`)).trim();
    if (!VERSION.test(version))
      return yield* cliInstallationError(
        "download",
        "Anthropic's download service did not return a version. It may be unavailable in this region.",
      );
    const leftover = yield* readDownload;
    if (leftover)
      for (const name of yield* fs.readDirectory(downloadsDir))
        if (DOWNLOAD_NAME.test(name)) yield* fs.remove(path.join(downloadsDir, name));
    yield* update({
      version,
      download: leftover ? "restarted" : "fresh",
      message: leftover
        ? "Restarting the Claude download that stopped part-way."
        : "Downloading Claude.",
    });
    const script = yield* fetchText(INSTALLER_URL);
    const workDir = yield* fs.makeTempDirectoryScoped({ prefix: "claude-install-" });
    const scriptPath = path.join(workDir, "install.sh");
    yield* fs.writeFileString(scriptPath, script, { mode: 0o700 });
    const child = yield* spawner.spawn(
      ChildProcess.make("/bin/bash", [scriptPath], {
        cwd: workDir,
        env: environment,
        extendEnv: false,
        stdin: "ignore",
      }),
    );
    yield* watchProgress(update).pipe(Effect.forkScoped);
    const [, errors, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.runDrain),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* cliInstallationError(
        "install",
        lastLine(errors) ?? `Anthropic's installer stopped with exit code ${exitCode}.`,
      );
    yield* update({ phase: "verifying", message: "Checking Claude." });
    const executablePath = yield* userCliPath("claude");
    const installedVersion = yield* readCliVersion(executablePath, environment);
    if (!installedVersion)
      return yield* cliInstallationError(
        "verify",
        "Claude was installed but does not start. Try installing again.",
      );
    return { executablePath, version: installedVersion };
  }, Effect.timeout("45 minutes"));

  return yield* makeCliInstallRunner({
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    findInstalled: findInstalledCli("claude", environment).pipe(Effect.provide(context)),
    install: (update) =>
      install(update).pipe(
        Effect.provide(context),
        Effect.mapError((cause) =>
          cause._tag === "CliInstallationError"
            ? cause
            : cliInstallationError(
                "install",
                cause._tag === "TimeoutError"
                  ? "Installing Claude took too long. Try again."
                  : "Could not install Claude. Check disk space, then try again.",
                cause,
              ),
        ),
      ),
  });
});
