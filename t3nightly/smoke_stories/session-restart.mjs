#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const tree = process.argv[2];
const home = process.argv[3];
const out = process.argv[4];
assert(tree && home && out);
const build = Number(process.env.T3_SMOKE_VERSION?.match(/\.aneym\.(\d+)$/)?.[1]);
if (build < 27) {
  console.log('SKIP: restart refusal while work is live ships in aneym.27');
  process.exit(0);
}
assert.notEqual(await realpath(home), await realpath(join(homedir(), '.t3')).catch(() => join(homedir(), '.t3')));
await mkdir(out, { recursive: true });
const execute = promisify(execFile);
const output = join(out, 'session-restart-proof.json');
const evidence = { startedAt: new Date().toISOString(), attempts: [], assertions: [] };
const note = (assertion) => {
  evidence.assertions.push(assertion);
  return writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
};
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
const { THREAD_SESSION_RESTART_REASON: reason } = await load(`${tree}/packages/contracts/src/orchestrationV2.ts`);
assert(reason, 'contracts lack THREAD_SESSION_RESTART_REASON');
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
    return yield* body(session.client);
  }).pipe(Effect.scoped, Effect.provide(layers)));
};

const millis = (value) => (typeof value === 'string' ? Date.parse(value) : value?.epochMilliseconds);
const live = (status) => ['preparing', 'starting', 'running', 'waiting'].includes(status);
const backgroundTasks = (projection) => projection.providerThreads.reduce((total, thread) => total + (thread.pendingBackgroundTasks?.length ?? 0), 0);
const work = join(home, `session-restart-story-${Date.now()}`);
let threadId;
try {
  evidence.cli = { executable: process.env.T3_SMOKE_CLI ?? `${tree}/apps/server/src/bin.ts`, version: process.env.T3_SMOKE_VERSION ?? null };
  const repo = join(work, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'smoke\n');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '-qm', 'init');
  await t3(['project', 'add', repo]);
  threadId = lastJson(await t3(['thread', 'start', '--provider', 'claudeAgent', '--model', 'claude-sonnet-5-5', '--title', 'Session restart story', '--json', repo, 'Run the shell command `sleep 20` in the foreground, wait for it, then reply with exactly RUNDONE.'], repo)).threadId;
  evidence.threadId = threadId;
  await rpc((client) => Effect.gen(function* () {
    const read = () => client['orchestration.getThreadProjection']({ threadId });
    const until = (label, test, seconds) => Effect.gen(function* () {
      for (let second = 0; second < seconds; second += 1) {
        const projection = yield* read();
        if (test(projection)) return projection;
        yield* Effect.sleep('1 second');
      }
      return yield* Effect.fail(new Error(`timed out waiting for ${label}`));
    });
    const restart = (label, projection) => Effect.gen(function* () {
      const session = projection.providerSessions.find((candidate) => candidate.status !== 'stopped' && candidate.status !== 'error');
      assert(session, `no live provider session at ${label}`);
      const result = yield* Effect.result(client['orchestration.dispatchCommand']({
        type: 'provider-session.detach', commandId: `smoke:session-restart:${Date.now()}:${label}`, threadId, providerSessionId: session.id, reason,
      }));
      const refused = result._tag === 'Failure';
      evidence.attempts.push({ label, refused, runs: projection.runs.map((run) => run.status), backgroundTasks: backgroundTasks(projection), error: refused ? String(result.failure?.message ?? JSON.stringify(result.failure)).slice(0, 400) : null });
      return refused;
    });

    const running = yield* until('a live run with a session', (projection) => projection.runs.some((run) => run.status === 'running') && projection.providerSessions.some((session) => session.status !== 'stopped'), 120);
    assert.equal(yield* restart('during-run', running), true, 'restart was accepted while a run was live');
    yield* Effect.promise(() => note('restart refused while a run is live'));
    const finished = yield* until('the first run to finish', (projection) => projection.runs.length > 0 && projection.runs.every((run) => !live(run.status)), 150);
    assert.equal(finished.runs.at(-1).status, 'completed', `run ended ${finished.runs.at(-1).status}`);
    yield* Effect.promise(() => note('the live run completed instead of being interrupted'));

    yield* Effect.promise(() => t3(['thread', 'send', '--wait', threadId, 'Use the Bash tool with run_in_background set to true to run `sleep 60`. Do not wait for it. Reply with exactly BGSTARTED.']));
    const pending = yield* until('a pending background task', (projection) => backgroundTasks(projection) > 0 && projection.runs.every((run) => !live(run.status)), 30);
    assert.equal(yield* restart('background-task', pending), true, 'restart was accepted while a background task was live');
    yield* Effect.promise(() => note('restart refused while a background task is live and no run is'));
    const quiet = (projection) => backgroundTasks(projection) === 0 && projection.runs.every((run) => !live(run.status));
    const settled = (label) => Effect.gen(function* () {
      let streak = 0;
      let runs = -1;
      for (let second = 0; second < 150; second += 1) {
        const projection = yield* read();
        streak = quiet(projection) && projection.runs.length === runs ? streak + 1 : 0;
        runs = projection.runs.length;
        if (streak >= 5) return projection;
        yield* Effect.sleep('1 second');
      }
      return yield* Effect.fail(new Error(`timed out waiting for ${label}`));
    });
    let idle = yield* settled('the background task to finish and the thread to settle');
    let refused = yield* restart('idle', idle);
    if (refused) {
      const after = yield* read();
      assert(after.runs.length > idle.runs.length, 'restart was refused on an idle thread');
      yield* Effect.promise(() => note('a run started after the idle read, so the refusal was honest; waiting for it to settle'));
      idle = yield* settled('the follow-up run to settle');
      refused = yield* restart('idle-retry', idle);
    }
    assert.equal(refused, false, 'restart was refused on an idle thread');
    const before = idle.providerSessions.find((session) => session.status !== 'stopped' && session.status !== 'error');
    assert(before, 'no live provider session before the idle restart');
    evidence.oldSession = { id: before.id, createdAt: millis(before.createdAt) };
    assert(Number.isFinite(evidence.oldSession.createdAt), 'unreadable session createdAt');
    yield* until('the old session to detach', (projection) => !projection.providerSessions.some((session) => session.id === before.id && millis(session.createdAt) === evidence.oldSession.createdAt), 30);
    yield* Effect.promise(() => note('restart accepted once the thread is idle and the old session detached'));
  }));
  const reply = await t3(['thread', 'send', '--wait', threadId, 'Reply with exactly AFTERRESTART. Do not use any tools.']);
  assert.match(reply, /AFTERRESTART/, 'thread did not answer after restart');
  const fresh = await rpc((client) => client['orchestration.getThreadProjection']({ threadId }));
  const reopened = fresh.providerSessions.find((session) => session.status !== 'stopped' && session.status !== 'error');
  assert(reopened, 'no provider session after the restart turn');
  evidence.newSession = { id: reopened.id, createdAt: millis(reopened.createdAt) };
  assert(evidence.newSession.createdAt > evidence.oldSession.createdAt, 'the restart turn reused the old session');
  await note('the next turn runs on a newly opened session');
  evidence.pass = true;
} catch (error) {
  evidence.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (threadId) await t3(['thread', 'archive', threadId]).catch(() => {});
  evidence.finishedAt = new Date().toISOString();
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(evidence.pass ? `PASS: ${evidence.assertions.length} assertions, proof ${output}` : `FAIL: ${evidence.error?.split('\n')[0]}`);
