// @effect-diagnostics nodeBuiltinImport:off -- the archive is read as a gzip stream and written file by file.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import type { ClientExtrasManifest } from "./clientExtras.ts";

const BLOCK = 512;

interface OpenEntry {
  readonly name: string;
  readonly size: number;
  readonly expected: string;
  readonly hash: NodeCrypto.Hash;
  readonly handle: NodeFSP.FileHandle;
  remaining: number;
}

function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function entryName(header: Buffer): string {
  const name = field(header, 0, 100);
  const prefix = field(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function entrySize(header: Buffer): number {
  const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("bad entry size");
  return size;
}

async function closeEntry(entry: OpenEntry) {
  await entry.handle.close();
  const digest = entry.hash.digest("hex");
  if (digest !== entry.expected) throw new Error(`${entry.name} does not match its sha256`);
}

/** Writes only the manifest's regular files into `stagingDir`, each checked against its size and sha256. */
export async function extractClientExtras(
  archivePath: string,
  stagingDir: string,
  files: ClientExtrasManifest["files"],
): Promise<void> {
  const written = new Set<string>();
  const source = NodeFS.createReadStream(archivePath).pipe(NodeZlib.createGunzip());
  let pending: Buffer = Buffer.alloc(0);
  let entry: OpenEntry | undefined;
  let padding = 0;
  let finished = false;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      if (finished) continue;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length > 0) {
        if (padding > 0) {
          const skip = Math.min(padding, pending.length);
          pending = pending.subarray(skip);
          padding -= skip;
          continue;
        }
        if (entry !== undefined) {
          const take = Math.min(entry.remaining, pending.length);
          const part = pending.subarray(0, take);
          entry.hash.update(part);
          await entry.handle.write(part);
          entry.remaining -= take;
          pending = pending.subarray(take);
          if (entry.remaining > 0) break;
          await closeEntry(entry);
          padding = (BLOCK - (entry.size % BLOCK)) % BLOCK;
          entry = undefined;
          continue;
        }
        if (pending.length < BLOCK) break;
        const header = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        if (header.every((byte) => byte === 0)) {
          finished = true;
          break;
        }
        const name = entryName(header);
        const type = String.fromCharCode(header[156] ?? 0);
        if (type !== "0" && type !== "\0") throw new Error(`${name} is not a regular file`);
        const listed = Object.hasOwn(files, name) ? files[name] : undefined;
        if (listed === undefined || written.has(name)) throw new Error(`${name} is not listed`);
        const size = entrySize(header);
        if (size !== listed.size) throw new Error(`${name} is ${size} bytes, not ${listed.size}`);
        written.add(name);
        const target = NodePath.join(stagingDir, name);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        entry = {
          name,
          size,
          expected: listed.sha256,
          hash: NodeCrypto.createHash("sha256"),
          handle: await NodeFSP.open(target, "wx", 0o644),
          remaining: size,
        };
        if (size === 0) {
          await closeEntry(entry);
          entry = undefined;
        }
      }
    }
  } finally {
    await entry?.handle.close().catch(() => undefined);
    source.destroy();
  }
  if (entry !== undefined || !finished) throw new Error("the archive ended early");
  const missing = Object.keys(files).filter((name) => !written.has(name));
  if (missing.length > 0) throw new Error(`the archive lacks ${missing.length} listed files`);
}
