// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { cliInstallationError } from "./cliInstallRunner.ts";

const RELEASES_URL = "https://releases.openai.com/codex";
const GITHUB_DOWNLOAD_URL = "https://github.com/openai/codex/releases/download";
const GITHUB_LATEST_URL = "https://api.github.com/repos/openai/codex/releases/latest";
const SUMS_ASSET = "codex-package_SHA256SUMS";
const SHA256 = /^sha256:([0-9a-f]{64})$/u;

const ReleaseMetadata = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(
    Schema.Struct({ name: Schema.String, digest: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
});
const decodeRelease = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseMetadata));

export interface CodexRelease {
  readonly version: string;
  readonly target: string;
  readonly releaseName: string;
  readonly archiveUrls: ReadonlyArray<string>;
  readonly archiveSha256: string;
}

const isRosetta = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"], { stdin: "ignore" }),
  );
  const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
  return output.trim() === "1";
}).pipe(
  Effect.scoped,
  Effect.orElseSucceed(() => false),
);

export const resolveCodexTarget = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  if (platform === "darwin") {
    const arm = arch === "arm64" || (arch === "x64" && (yield* isRosetta));
    return arm ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux" && (arch === "x64" || arch === "arm64"))
    return arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
  return yield* cliInstallationError(
    "start",
    `OpenAI does not publish a Codex package for ${platform}-${arch} that this helper can place.`,
  );
});

const download = Effect.fn("codexRelease.download")(function* (url: string) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http
    .execute(HttpClientRequest.get(url))
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  return new Uint8Array(yield* response.arrayBuffer);
}, Effect.timeout("60 seconds"));

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const fromMetadata = Effect.fn("codexRelease.fromMetadata")(function* (
  metadataUrl: string,
  assetUrl: (version: string, asset: string) => string,
  target: string,
) {
  const metadata = yield* download(metadataUrl).pipe(
    Effect.flatMap((bytes) => decodeRelease(new TextDecoder().decode(bytes))),
  );
  const version = metadata.tag_name.replace(/^rust-v/u, "");
  const archive = `codex-package-${target}.tar.gz`;
  const sumsDigest = SHA256.exec(
    metadata.assets.find((asset) => asset.name === SUMS_ASSET)?.digest ?? "",
  )?.[1];
  if (!metadata.assets.some((asset) => asset.name === archive) || !sumsDigest)
    return yield* cliInstallationError(
      "download",
      `OpenAI's Codex ${version} release has no package for this Mac.`,
    );
  const sums = yield* download(assetUrl(version, SUMS_ASSET));
  if (sha256(sums) !== sumsDigest)
    return yield* cliInstallationError(
      "verify",
      "OpenAI's Codex checksum list failed its own checksum. Nothing was installed.",
    );
  const archiveSha256 = new TextDecoder()
    .decode(sums)
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .find((parts) => parts[1] === archive)?.[0]
    ?.toLowerCase();
  if (!archiveSha256 || !/^[0-9a-f]{64}$/u.test(archiveSha256))
    return yield* cliInstallationError(
      "verify",
      "OpenAI's Codex checksum list does not cover this package. Nothing was installed.",
    );
  return {
    version,
    target,
    releaseName: `${version}-${target}`,
    archiveUrls: [
      `${RELEASES_URL}/releases/${version}/${archive}`,
      `${GITHUB_DOWNLOAD_URL}/rust-v${version}/${archive}`,
    ],
    archiveSha256,
  } satisfies CodexRelease;
});

export const resolveCodexRelease = Effect.fn("resolveCodexRelease")(function* (target: string) {
  return yield* fromMetadata(
    `${RELEASES_URL}/channels/latest`,
    (version, asset) => `${RELEASES_URL}/releases/${version}/${asset}`,
    target,
  ).pipe(
    Effect.catchIf(
      (error) => error._tag !== "CliInstallationError",
      () =>
        fromMetadata(
          GITHUB_LATEST_URL,
          (version, asset) => `${GITHUB_DOWNLOAD_URL}/rust-v${version}/${asset}`,
          target,
        ),
    ),
    Effect.mapError((cause) =>
      cause._tag === "CliInstallationError"
        ? cause
        : cliInstallationError(
            "download",
            "Could not reach OpenAI's release service. Check the internet connection, then try again.",
            cause,
          ),
    ),
  );
});
