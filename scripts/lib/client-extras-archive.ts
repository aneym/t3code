// @effect-diagnostics nodeBuiltinImport:off - Node's crypto and zlib hash the assets and write the gzip archive.
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CLIENT_EXTRAS_MANIFEST_FILE,
  CLIENT_EXTRAS_PATH_PATTERN,
  ClientExtrasManifest,
  clientExtrasArchiveFileName,
} from "@t3tools/shared/clientExtras";

const OFFICE_PACKAGES_DIR = "apps/web/node_modules/@betteroffice";
const DEFERRED_EXTENSION = /\.(?:otf|ttf|wasm)$/;
const GZIP_OS_BYTE = 9;
const GZIP_OS_UNIX = 3;
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(ClientExtrasManifest));

export class ClientExtrasBuildError extends Schema.TaggedError<ClientExtrasBuildError>()(
  "ClientExtrasBuildError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Client extras: ${this.detail}`;
  }
}

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function ustarHeader(name: string, size: number): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(size, 12), 124, "ascii");
  header.write(octal(0, 12), 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

/** Office fonts and engines that arrive byte for byte from the @betteroffice packages. */
const officeAssetDigests = Effect.fn("officeAssetDigests")(function* (repoRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digests = new Set<string>();
  const packagesDir = path.join(repoRoot, OFFICE_PACKAGES_DIR);
  for (const pkg of yield* fs.readDirectory(packagesDir)) {
    const pkgDir = yield* fs.realPath(path.join(packagesDir, pkg));
    for (const entry of yield* fs.readDirectory(pkgDir, { recursive: true })) {
      if (DEFERRED_EXTENSION.test(entry)) {
        digests.add(sha256(yield* fs.readFile(path.join(pkgDir, entry))));
      }
    }
  }
  if (digests.size === 0) {
    return yield* new ClientExtrasBuildError({ detail: `no assets under ${OFFICE_PACKAGES_DIR}` });
  }
  return digests;
});

/**
 * Moves the Office viewer's assets out of a staged client into one gzip tar, and pins each file's size and
 * sha256 in the client's manifest so the server can fetch, check and serve them on first use.
 */
export const deferClientExtras = Effect.fn("deferClientExtras")(function* (input: {
  readonly repoRoot: string;
  readonly clientDir: string;
  readonly version: string;
  readonly outputDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digests = yield* officeAssetDigests(input.repoRoot);
  const files: Record<string, { size: number; sha256: string }> = {};
  const chunks: Array<Uint8Array> = [];
  const assets = (yield* fs.readDirectory(path.join(input.clientDir, "assets"))).toSorted();
  for (const asset of assets) {
    const name = `assets/${asset}`;
    if (!DEFERRED_EXTENSION.test(asset)) continue;
    const bytes = yield* fs.readFile(path.join(input.clientDir, name));
    const digest = sha256(bytes);
    if (!digests.has(digest)) continue;
    if (!CLIENT_EXTRAS_PATH_PATTERN.test(name) || Buffer.byteLength(name) > 100) {
      return yield* new ClientExtrasBuildError({ detail: `unsupported asset name ${name}` });
    }
    files[name] = { size: bytes.byteLength, sha256: digest };
    chunks.push(ustarHeader(name, bytes.byteLength), bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  if (Object.keys(files).length === 0) {
    return yield* new ClientExtrasBuildError({ detail: "no Office assets found in the client" });
  }
  chunks.push(new Uint8Array(1024));
  const archive = NodeZlib.gzipSync(Buffer.concat(chunks), { level: 9 });
  archive[GZIP_OS_BYTE] = GZIP_OS_UNIX;
  yield* fs.makeDirectory(input.outputDir, { recursive: true });
  const archivePath = path.join(input.outputDir, clientExtrasArchiveFileName(input.version));
  yield* fs.writeFile(archivePath, archive);
  for (const name of Object.keys(files)) {
    yield* fs.remove(path.join(input.clientDir, name));
  }
  yield* fs.writeFileString(
    path.join(input.clientDir, CLIENT_EXTRAS_MANIFEST_FILE),
    `${yield* encodeManifest({ version: input.version, files })}\n`,
  );
  const deferredBytes = Object.values(files).reduce((sum, file) => sum + file.size, 0);
  yield* Effect.log(
    `[cli-archive] Deferred ${Object.keys(files).length} Office assets (${deferredBytes} bytes) to ${archivePath} (${archive.byteLength} bytes).`,
  );
  return archivePath;
});
