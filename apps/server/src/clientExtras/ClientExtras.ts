import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  CLIENT_EXTRAS_MANIFEST_FILE,
  ClientExtrasManifest,
  clientExtrasArchiveFileName,
} from "@t3tools/shared/clientExtras";
import { CLI_RELEASE_BASE_URL_ENV, cliReleaseAssetUrl } from "@t3tools/shared/cliRelease";

import * as ServerConfig from "../config.ts";
import { extractClientExtras } from "@t3tools/shared/clientExtrasExtract";

const REQUEST_HOLD = Duration.seconds(15);
const DOWNLOAD_STALL_TIMEOUT = Duration.minutes(1);
const FAILURE_COOLDOWN = Duration.seconds(10);
const RETRY_AFTER_SECONDS = "2";

export class ClientExtrasDownloadError extends Schema.TaggedError<ClientExtrasDownloadError>()(
  "ClientExtrasDownloadError",
  { step: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Office viewer files failed while ${this.step}.`;
  }
}

export type ClientExtrasLookup =
  | { readonly _tag: "Unlisted" }
  | { readonly _tag: "Ready"; readonly filePath: string }
  | { readonly _tag: "Respond"; readonly response: HttpServerResponse.HttpServerResponse };

export class ClientExtras extends Context.Service<
  ClientExtras,
  { readonly lookup: (relativePath: string) => Effect.Effect<ClientExtrasLookup> }
>()("t3/clientExtras/ClientExtras") {}

type DownloadState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly done: Deferred.Deferred<boolean> }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Failed"; readonly at: number };

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientExtrasManifest));

const pendingResponse = () =>
  HttpServerResponse.text("Office viewer files are downloading. Retry shortly.", {
    status: 503,
    headers: { "Retry-After": RETRY_AFTER_SECONDS, "Cache-Control": "no-store" },
  });

const failedResponse = () =>
  HttpServerResponse.text(
    `Office viewer files could not be downloaded. Set ${CLI_RELEASE_BASE_URL_ENV} to a release mirror and restart T3.`,
    { status: 502, headers: { "Cache-Control": "no-store" } },
  );

const unlisted: ClientExtrasLookup = { _tag: "Unlisted" };

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Scope.Scope;
  const staticDir =
    config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
  const manifest = staticDir
    ? yield* fs
        .readFileString(path.join(staticDir, CLIENT_EXTRAS_MANIFEST_FILE))
        .pipe(Effect.flatMap(decodeManifest), Effect.option)
    : Option.none<ClientExtrasManifest>();
  if (Option.isNone(manifest)) {
    return ClientExtras.of({
      lookup: Effect.fn("ClientExtras.lookupNone")(() => Effect.succeed(unlisted)),
    });
  }
  const { version, files } = manifest.value;
  const cacheRoot = path.join(config.baseDir, "caches", "client-extras");
  const versionDir = path.join(cacheRoot, version);

  const isInstalled = Effect.forEach(Object.entries(files), ([name, file]) =>
    fs.stat(path.join(versionDir, name)).pipe(
      Effect.map((info) => info.type === "File" && Number(info.size) === file.size),
      Effect.orElseSucceed(() => false),
    ),
  ).pipe(Effect.map((checks) => checks.every(Boolean)));

  const fetchArchive = Effect.fn("ClientExtras.fetchArchive")(function* (archivePath: string) {
    const releaseBaseUrl = Option.getOrUndefined(
      yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(
        Config.option,
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
    );
    const url = cliReleaseAssetUrl(version, clientExtrasArchiveFileName(version), releaseBaseUrl);
    yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(DOWNLOAD_STALL_TIMEOUT),
      Effect.flatMap((response) =>
        response.stream.pipe(
          Stream.timeoutOrElse({
            duration: DOWNLOAD_STALL_TIMEOUT,
            orElse: () =>
              Stream.fail(new ClientExtrasDownloadError({ step: "downloading (stalled)" })),
          }),
          Stream.run(fs.sink(archivePath, { flag: "w", mode: 0o600 })),
        ),
      ),
      Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds") }),
      Effect.mapError(
        (cause) =>
          new ClientExtrasDownloadError({ step: `downloading ${new URL(url).host}`, cause }),
      ),
    );
  });

  const install = Effect.fn("ClientExtras.install")(function* () {
    if (yield* isInstalled) return;
    const fail = (step: string) => (cause: unknown) =>
      new ClientExtrasDownloadError({ step, cause });
    yield* fs
      .makeDirectory(cacheRoot, { recursive: true })
      .pipe(Effect.mapError(fail("creating the cache")));
    const stagingDir = yield* fs
      .makeTempDirectory({ directory: cacheRoot, prefix: ".staging-" })
      .pipe(Effect.mapError(fail("creating the staging folder")));
    const archivePath = `${stagingDir}.tar.gz`;
    yield* Effect.gen(function* () {
      yield* fetchArchive(archivePath);
      yield* Effect.tryPromise({
        try: () => extractClientExtras(archivePath, stagingDir, files),
        catch: fail("checking the archive"),
      });
      yield* fs.remove(versionDir, { recursive: true, force: true });
      yield* fs.rename(stagingDir, versionDir).pipe(Effect.mapError(fail("publishing the files")));
      const stale = yield* fs.readDirectory(cacheRoot).pipe(Effect.orElseSucceed(() => []));
      for (const entry of stale) {
        if (entry !== version && !entry.startsWith(".staging-")) {
          yield* fs.remove(path.join(cacheRoot, entry), { recursive: true, force: true });
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.all([
          fs.remove(archivePath, { force: true }),
          fs.remove(stagingDir, { recursive: true, force: true }),
        ]).pipe(Effect.ignore),
      ),
      Effect.mapError((cause) =>
        cause._tag === "ClientExtrasDownloadError" ? cause : fail("installing the files")(cause),
      ),
    );
  });

  let state: DownloadState = (yield* isInstalled) ? { _tag: "Ready" } : { _tag: "Idle" };

  const run = (done: Deferred.Deferred<boolean>) =>
    install().pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Office viewer files failed to install", { error: error.message }),
      ),
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const ok = exit._tag === "Success";
          const at = yield* Clock.currentTimeMillis;
          state = ok ? { _tag: "Ready" } : { _tag: "Failed", at };
          yield* Deferred.succeed(done, ok);
        }),
      ),
      Effect.forkIn(scope),
    );

  const claim = (now: number) =>
    Effect.sync(() => {
      const current = state;
      if (current._tag === "Ready") return { done: undefined, ok: true, fresh: false };
      if (current._tag === "Running") return { done: current.done, ok: false, fresh: false };
      if (current._tag === "Failed" && now - current.at < Duration.toMillis(FAILURE_COOLDOWN)) {
        return { done: undefined, ok: false, fresh: false };
      }
      const done = Deferred.makeUnsafe<boolean>();
      state = { _tag: "Running", done };
      return { done, ok: false, fresh: true };
    });

  const ensure = Effect.gen(function* () {
    const claimed = yield* claim(yield* Clock.currentTimeMillis);
    if (claimed.done === undefined) return Option.some(claimed.ok);
    if (claimed.fresh) yield* run(claimed.done);
    return yield* Deferred.await(claimed.done).pipe(Effect.timeoutOption(REQUEST_HOLD));
  });

  const lookup = Effect.fn("ClientExtras.lookup")(function* (relativePath: string) {
    if (!Object.hasOwn(files, relativePath)) return unlisted;
    const outcome = yield* ensure;
    if (Option.isNone(outcome)) return { _tag: "Respond", response: pendingResponse() } as const;
    if (!outcome.value) return { _tag: "Respond", response: failedResponse() } as const;
    return { _tag: "Ready", filePath: path.join(versionDir, relativePath) } as const;
  });

  return ClientExtras.of({ lookup });
});

export const layer = Layer.effect(ClientExtras, make);
