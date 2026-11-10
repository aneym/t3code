// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export type DownloadStart = "fresh" | "resumed" | "restarted";

export interface DownloadedFile {
  readonly sha256: string;
  readonly bytes: number;
  readonly start: DownloadStart;
}

const partialSize = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.map((info) => (info.type === "File" ? Number(info.size) : 0)),
    Effect.orElseSucceed(() => 0),
  );

export const downloadResumable = Effect.fn("downloadResumable")(function* (options: {
  readonly url: string;
  readonly partialPath: string;
  readonly onStart: (
    start: DownloadStart,
    downloadedBytes: number,
    totalBytes: number | null,
  ) => Effect.Effect<void>;
  readonly onProgress: (downloadedBytes: number) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const existing = yield* partialSize(fs, options.partialPath);
  const request = HttpClientRequest.get(options.url);
  let response = yield* http.execute(
    existing > 0 ? HttpClientRequest.setHeader(request, "Range", `bytes=${existing}-`) : request,
  );
  const resumed = existing > 0 && response.status === 206;
  if (!resumed) {
    if (existing > 0) {
      yield* fs.remove(options.partialPath, { force: true });
      if (response.status === 416) response = yield* http.execute(request);
    }
    response = yield* HttpClientResponse.filterStatusOk(response);
  }
  const hash = NodeCrypto.createHash("sha256");
  if (resumed)
    yield* fs
      .stream(options.partialPath)
      .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
  const offset = resumed ? existing : 0;
  const length = Number(response.headers["content-length"]);
  const totalBytes = Number.isSafeInteger(length) ? offset + length : null;
  const start: DownloadStart = resumed ? "resumed" : existing > 0 ? "restarted" : "fresh";
  yield* options.onStart(start, offset, totalBytes);
  let downloadedBytes = offset;
  let reportedAt = 0;
  yield* response.stream.pipe(
    Stream.tap((chunk) =>
      Effect.gen(function* () {
        downloadedBytes += chunk.byteLength;
        hash.update(chunk);
        const now = yield* Clock.currentTimeMillis;
        if (now - reportedAt < 250) return;
        reportedAt = now;
        yield* options.onProgress(downloadedBytes);
      }),
    ),
    Stream.run(fs.sink(options.partialPath, { flag: resumed ? "a" : "w", mode: 0o600 })),
  );
  yield* options.onProgress(downloadedBytes);
  return { sha256: hash.digest("hex"), bytes: downloadedBytes, start } satisfies DownloadedFile;
});
