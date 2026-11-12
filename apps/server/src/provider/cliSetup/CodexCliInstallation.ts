import { ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import {
  cliInstallationError,
  makeCliInstallRunner,
  type CliInstallUpdate,
} from "./cliInstallRunner.ts";
import { placeCodexRelease } from "./codexPlacement.ts";
import { resolveCodexRelease, resolveCodexTarget } from "./codexRelease.ts";
import { findInstalledCli } from "./installedCli.ts";
import { downloadResumable } from "./resumableDownload.ts";

export const makeCodexCliInstallation = Effect.fn("makeCodexCliInstallation")(function* () {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const context = Context.pick(
    FileSystem.FileSystem,
    Path.Path,
    ChildProcessSpawner.ChildProcessSpawner,
    HttpClient.HttpClient,
  )(
    yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | HttpClient.HttpClient
    >(),
  );
  const downloadsDir = path.join(baseDir, "tools", "downloads");

  const install = Effect.fn("CodexCliInstallation.install")(function* (update: CliInstallUpdate) {
    const release = yield* resolveCodexRelease(yield* resolveCodexTarget);
    yield* update({ version: release.version });
    yield* fs.makeDirectory(downloadsDir, { recursive: true });
    const partialPath = path.join(downloadsDir, `codex-${release.releaseName}.tar.gz.part`);
    const fetchFrom = (url: string) =>
      downloadResumable({
        url,
        partialPath,
        onStart: (start, downloadedBytes, totalBytes) =>
          update({
            download: start,
            downloadedBytes,
            totalBytes,
            message:
              start === "resumed"
                ? "Resuming the Codex download."
                : start === "restarted"
                  ? "Restarting the Codex download from the beginning."
                  : "Downloading Codex.",
          }),
        onProgress: (downloadedBytes) => update({ downloadedBytes }),
      });
    const [primary, fallback] = release.archiveUrls;
    const downloaded = yield* fetchFrom(primary ?? "").pipe(
      Effect.catchTags({
        HttpClientError: (error) => (fallback ? fetchFrom(fallback) : Effect.fail(error)),
      }),
    );
    if (downloaded.sha256 !== release.archiveSha256) {
      yield* fs.remove(partialPath, { force: true });
      return yield* cliInstallationError(
        "verify",
        "The Codex download failed its SHA-256 check against OpenAI's checksum list. Nothing was installed.",
      );
    }
    yield* update({ phase: "extracting", message: "Setting up Codex." });
    const installed = yield* placeCodexRelease({
      release,
      archivePath: partialPath,
      environment,
    });
    yield* update({ phase: "verifying", message: "Checking Codex." });
    yield* fs.remove(partialPath, { force: true });
    return installed;
  }, Effect.timeout("45 minutes"));

  return yield* makeCliInstallRunner({
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    findInstalled: findInstalledCli("codex", environment).pipe(Effect.provide(context)),
    install: (update) =>
      install(update).pipe(
        Effect.provide(context),
        Effect.mapError((cause) =>
          cause._tag === "CliInstallationError"
            ? cause
            : cliInstallationError(
                "install",
                cause._tag === "TimeoutError"
                  ? "Installing Codex took too long. Try again."
                  : cause._tag === "HttpClientError"
                    ? "The Codex download was interrupted. Try again to resume it."
                    : "Could not install Codex. Check disk space, then try again.",
                cause,
              ),
        ),
      ),
  });
});
