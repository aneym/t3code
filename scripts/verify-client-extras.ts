#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - A release gate run by hand or by the fold before upload.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CLIENT_EXTRAS_MANIFEST_FILE,
  ClientExtrasManifest,
  clientExtrasArchiveFileName,
} from "@t3tools/shared/clientExtras";
import * as Schema from "effect/Schema";

import { extractClientExtras } from "@t3tools/shared/clientExtrasExtract";

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(ClientExtrasManifest));

async function verify(releaseDir: string, version: string): Promise<void> {
  const extras = NodePath.join(releaseDir, clientExtrasArchiveFileName(version));
  await NodeFSP.access(extras).catch(() => {
    throw new Error(`missing ${extras}; build with --defer-client-extras`);
  });
  const engines = (await NodeFSP.readdir(releaseDir)).filter(
    (name) => name.startsWith(`t3-${version}-`) && name !== NodePath.basename(extras),
  );
  if (engines.length === 0) throw new Error(`no t3-${version}-* engine archives in ${releaseDir}`);
  for (const engine of engines) {
    const stem = engine.replace(/\.(?:tar\.gz|zip)$/, "");
    const member = `${stem}/client/${CLIENT_EXTRAS_MANIFEST_FILE}`;
    const tarArgs = engine.endsWith(".zip") ? ["-xOf"] : ["-xzOf"];
    const raw = NodeChildProcess.execFileSync("tar", [...tarArgs, engine, member], {
      cwd: releaseDir,
      maxBuffer: 16 * 1024 * 1024,
    }).toString("utf8");
    const manifest = decodeManifest(raw);
    if (manifest.version !== version) {
      throw new Error(`${engine} pins version ${manifest.version}, not ${version}`);
    }
    const staging = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-client-extras-"));
    try {
      await extractClientExtras(extras, staging, manifest.files);
    } finally {
      await NodeFSP.rm(staging, { recursive: true, force: true });
    }
    process.stdout.write(`ok ${engine}: ${Object.keys(manifest.files).length} files match\n`);
  }
}

const [releaseDir, version] = process.argv.slice(2);
if (!releaseDir || !version) {
  process.stderr.write("usage: verify-client-extras.ts <release dir> <version>\n");
  process.exit(2);
}
await verify(releaseDir, version).catch((error: unknown) => {
  process.stderr.write(`refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
