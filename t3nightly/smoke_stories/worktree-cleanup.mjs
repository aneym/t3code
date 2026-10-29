#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const tree = process.argv[2];
const home = process.argv[3];
const out = process.argv[4];
assert(tree && home && out);
const server = process.env.T3_SMOKE_CLI ? await realpath(process.env.T3_SMOKE_CLI) : `${tree}/packages/contracts/src/settings.ts`;
if (!(await readFile(server)).includes('worktreeContentIntegration')) {
  console.log(`SKIP: ${server} has no worktreeContentIntegration setting`);
  process.exit(0);
}
assert((await readFile(`${tree}/packages/contracts/src/settings.ts`)).includes('worktreeContentIntegration'), `${tree} contracts lack worktreeContentIntegration; its client would drop the cleanup guards`);
assert.notEqual(await realpath(home), await realpath(join(homedir(), '.t3')).catch(() => join(homedir(), '.t3')));
await mkdir(out, { recursive: true });
const execute = promisify(execFile);
const output = join(out, 'worktree-cleanup-proof.json');
const evidence = { startedAt: new Date().toISOString(), threads: {}, sweeps: [], assertions: [] };
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@example.com', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.com' };
const git = async (cwd, ...args) => (await execute('git', args, { cwd, env: gitEnv })).stdout.trim();
const lastJson = (text) => JSON.parse(text.trim().split('\n').findLast((line) => line.startsWith('{')));
const t3 = async (args, cwd = tree) => {
  const executable = process.env.T3_SMOKE_CLI ?? process.execPath;
  const prefix = process.env.T3_SMOKE_CLI ? [] : [`${tree}/apps/server/src/bin.ts`];
  const result = await execute(executable, [...prefix, ...args, '--base-dir', home], { cwd, timeout: 240000, maxBuffer: 8 * 1024 * 1024 })
    .catch((error) => { throw new Error(`t3 ${args.slice(0, 2).join(' ')} failed: ${String(error.stderr ?? '').trim().split('\n').at(-1)}`); });
  return result.stdout;
};

const src = `${tree}/packages/client-runtime/src`;
const effectRoot = await realpath(`${tree}/apps/mobile/node_modules/effect`);
const load = (path) => import(pathToFileURL(path).href);
const Effect = await load(`${effectRoot}/dist/Effect.js`);
const Layer = await load(`${effectRoot}/dist/Layer.js`);
const Socket = await load(`${effectRoot}/dist/socket/Socket.js`);
const Onboarding = await load(`${src}/connection/onboarding.ts`);
const Capabilities = await load(`${src}/platform/capabilities.ts`);
const Remote = await load(`${src}/authorization/remote.ts`);
const Descriptor = await load(`${src}/environment/descriptor.ts`);
const Http = await load(`${src}/rpc/http.ts`);
const RpcSession = await load(`${src}/rpc/session.ts`);
const Compatibility = await load(`${src}/connection/compatibility.ts`);
const metadata = { label: 'T3 smoke', deviceType: 'mobile', os: 'iOS', surface: 'mobile', appVersion: 't3nightly-smoke' };
const layers = Layer.mergeAll(
  Http.layerRemoteHttpClient(globalThis.fetch),
  RpcSession.layer({}).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
  Layer.succeed(Capabilities.ClientPresentation, Capabilities.ClientPresentation.of({ metadata })),
);
const rpc = async (body) => {
  const pairingUrl = (await t3(['pair', '--ttl', '5m'])).match(/^Pairing URL: (\S+)$/m)?.[1];
  assert(pairingUrl, 'no pairing URL');
  return Effect.runPromise(Effect.gen(function* () {
    const url = new URL(pairingUrl);
    const found = yield* Descriptor.fetchRemoteEnvironmentDescriptor({ httpBaseUrl: url.origin });
    const registration = yield* Onboarding.preparePairingRegistration({ pairingUrl: url.href, expectedEnvironmentId: found.environmentId });
    const token = registration.credential.token;
    const { httpBaseUrl, wsBaseUrl } = registration.profile;
    const socketUrl = yield* Remote.resolveRemoteWebSocketConnectionUrl({ wsBaseUrl, httpBaseUrl, bearerToken: token, clientMetadata: metadata, connectionMethod: 'direct' });
    const factory = yield* RpcSession.RpcSessionFactory;
    const session = yield* factory.connect({
      environmentId: registration.target.environmentId, label: registration.target.label, httpBaseUrl,
      socketUrl: Compatibility.appendOrchestrationProtocol(socketUrl), httpAuthorization: { _tag: 'Bearer', token }, target: registration.target,
    });
    const config = yield* session.initialConfig;
    return yield* body(session.client, config);
  }).pipe(Effect.scoped, Effect.provide(layers)));
};
const sweep = async (label, patch) => {
  const report = await rpc((client) => Effect.gen(function* () {
    const applied = (yield* client['server.updateSettings']({ patch: { storageCleanup: patch } })).storageCleanup;
    for (const [key, value] of Object.entries(patch)) assert.equal(applied?.[key], value, `server did not apply storageCleanup.${key}`);
    return yield* client['server.runStorageCleanup']({});
  }));
  const paths = new Set(Object.values(evidence.threads).map((thread) => thread.path));
  const entries = report.entries.filter((entry) => entry.kind === 'worktree' && paths.has(entry.path));
  evidence.sweeps.push({ label, patch, entries });
  return entries;
};

const work = join(home, `worktree-cleanup-story-${Date.now()}`);
let original;
try {
  original = await rpc((_client, config) => Effect.succeed(config.settings?.storageCleanup ?? null));
  assert(original, 'could not read storage cleanup settings to restore');
  evidence.cli = { executable: process.env.T3_SMOKE_CLI ?? `${tree}/apps/server/src/bin.ts`, version: process.env.T3_SMOKE_VERSION ?? null, reported: (await t3(['--version']).catch(() => '')).trim().split('\n').at(-1) };
  const origin = join(work, 'origin.git');
  const repo = join(work, `story-repo-${Date.now()}`);
  const lander = join(work, 'lander');
  await mkdir(work, { recursive: true });
  await git(work, 'init', '-q', '--bare', '-b', 'main', origin);
  await git(work, 'clone', '-q', origin, repo);
  await writeFile(join(repo, 'README.md'), 'smoke\n');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '-qm', 'init');
  await git(repo, 'push', '-q', 'origin', 'HEAD:main');
  await git(work, 'clone', '-q', origin, lander);
  await t3(['project', 'add', repo]);
  const start = async (name) => {
    const started = lastJson(await t3(['thread', 'start', '--worktree', 'main', '--branch', `story/${name}`, '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5', '--title', `Worktree cleanup story ${name}`, '--wait', '--json', repo, 'Reply with exactly OK. Do not use any tools.'], repo));
    const list = await git(repo, 'worktree', 'list', '--porcelain');
    const path = list.split('\n\n').find((block) => block.includes(`branch refs/heads/story/${name}`))?.match(/^worktree (.+)$/m)?.[1];
    assert(path, `no worktree for story/${name}`);
    evidence.threads[name] = { threadId: started.threadId, path };
    return path;
  };
  const [unlanded, squashed, extra] = await Promise.all(['unlanded', 'squashed', 'extra'].map(start));
  await writeFile(join(unlanded, 'unlanded.txt'), 'never pushed\n');
  await git(unlanded, 'add', '-A');
  await git(unlanded, 'commit', '-qm', 'unlanded');
  for (const [name, path] of [['squashed', squashed], ['extra', extra]]) {
    for (const line of ['one', 'two']) {
      await writeFile(join(path, `${name}.txt`), `${line}\n`, { flag: 'a' });
      await git(path, 'add', '-A');
      await git(path, 'commit', '-qm', `${name} ${line}`);
    }
    await git(path, 'push', '-q', 'origin', `HEAD:refs/heads/story/${name}`);
    await git(lander, 'pull', '-q', '--ff-only', 'origin', 'main');
    await git(lander, 'fetch', '-q', 'origin');
    await git(lander, 'merge', '-q', '--squash', `origin/story/${name}`);
    await git(lander, 'commit', '-qm', `squash ${name}`);
    await git(lander, 'push', '-q', 'origin', 'HEAD:main', `:refs/heads/story/${name}`);
  }
  await writeFile(join(extra, 'later.txt'), 'local only\n');
  await git(extra, 'add', '-A');
  await git(extra, 'commit', '-qm', 'extra after squash');
  for (const { threadId } of Object.values(evidence.threads)) await t3(['thread', 'settle', threadId]);
  await new Promise((resolve) => setTimeout(resolve, 66000));
  const rules = { worktreeKeepWhen: 'uncommitted-changes', worktreeSettledAfterDays: 0, worktreeAfterDays: null, worktreeOnMerge: false, worktreeOnDelete: false, worktreeUnchanged: true, worktreeRequireIntegrated: true };
  const off = await sweep('require landed, content off', { ...rules, worktreeContentIntegration: false });
  assert([unlanded, squashed, extra].every(existsSync), JSON.stringify(off));
  assert(off.some((entry) => entry.path === unlanded && entry.outcome === 'kept' && /not on the default branch/i.test(entry.reason ?? '')), JSON.stringify(off));
  evidence.assertions.push('settled worktree with an unpushed commit kept by Only delete landed worktrees');
  evidence.assertions.push('squash-landed worktree kept while content integration is off');
  const on = await sweep('require landed, content on', { ...rules, worktreeContentIntegration: true });
  assert(!existsSync(squashed), JSON.stringify(on));
  assert(existsSync(unlanded) && existsSync(extra), JSON.stringify(on));
  assert.equal(await git(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/story/squashed').then(Boolean, () => false), true);
  evidence.assertions.push('squash-landed worktree removed once content integration is on; branch ref kept');
  evidence.assertions.push('unlanded and squash-plus-local-commit worktrees still kept');
  for (const { threadId } of Object.values(evidence.threads)) await t3(['thread', 'archive', threadId]).catch(() => {});
  evidence.pass = true;
} catch (error) {
  evidence.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (original) {
    await rpc((client) => client['server.updateSettings']({ patch: { storageCleanup: original } })).then(
      () => { evidence.settingsRestored = true; },
      (error) => {
        evidence.pass = false;
        evidence.error = `settings restore failed: ${error}`;
        process.exitCode = 1;
      },
    );
  }
  evidence.completedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ pass: evidence.pass ?? false, output, error: evidence.error?.split('\n')[0], assertions: evidence.assertions }));
}
