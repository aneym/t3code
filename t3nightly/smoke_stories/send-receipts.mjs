#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tree = process.argv[2];
const home = process.argv[3];
const out = process.argv[4];
assert(tree && home && out);
const execute = promisify(execFile);
if (process.env.T3_SMOKE_CLI) {
  const help = await execute(process.env.T3_SMOKE_CLI, ['thread', 'send', '--help'], { timeout: 30000 });
  if (!help.stdout.includes('--request-id')) {
    const build = Number(process.env.T3_SMOKE_VERSION?.match(/\.aneym\.(\d+)$/)?.[1]);
    if (!(build < 26)) throw new Error(`CLI ${process.env.T3_SMOKE_VERSION} lacks send receipts (--request-id)`);
    console.log('SKIP: installed CLI predates send receipts (--request-id absent)');
    process.exit(0);
  }
}
assert.notEqual(await realpath(home), await realpath(join(homedir(), '.t3')).catch(() => join(homedir(), '.t3')));
await mkdir(out, { recursive: true });
const output = join(out, 'send-receipts-proof.json');
const require = createRequire(`${tree}/apps/server/package.json`);
const load = async (id) => import(pathToFileURL(require.resolve(id)).href);
const Effect = await load('effect/Effect');
const Option = await load('effect/Option');
const Schema = await load('effect/Schema');
const GlobalFlag = await load('effect/cli/GlobalFlag');
const NodeServices = await load('@effect/platform-node/NodeServices');
const Net = await import(pathToFileURL(`${tree}/packages/shared/src/Net.ts`).href);
const { withOwnerMcpTools } = await import(pathToFileURL(`${tree}/apps/server/src/cli/ownerMcpTools.ts`).href);
const runtimePath = `${home}/userdata/server-runtime.json`;
const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
const upstream = runtime.origin;
const dropped = new Set();
const faults = [];
const proxy = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    const response = await fetch(new URL(req.url, upstream), {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
    });
    const result = await response.text();
    let rpc;
    try { rpc = JSON.parse(body.toString()); } catch {}
    const key = rpc?.params?.arguments?.clientRequestId;
    if (rpc?.params?.name === 't3_thread_send' && key?.startsWith('fault-') && !dropped.has(key)) {
      dropped.add(key);
      faults.push({ key, upstreamStatus: response.status, upstreamResult: result });
      res.writeHead(504, { 'content-type': 'text/plain' });
      res.end('Forced response timeout after upstream completed');
      return;
    }
    const outgoing = Object.fromEntries(response.headers);
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'connection']) delete outgoing[name];
    res.writeHead(response.status, outgoing);
    res.end(result);
  } catch (error) {
    res.writeHead(502);
    res.end(String(error));
  }
});
await new Promise((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(0, '127.0.0.1', resolve);
});
await writeFile(runtimePath, JSON.stringify({ ...runtime, origin: `http://127.0.0.1:${proxy.address().port}` }));
const evidence = { startedAt: new Date().toISOString(), upstream, faults, receipts: [], failures: [], assertions: [] };
const cli = async (...args) => {
  const executable = process.env.T3_SMOKE_CLI ?? process.execPath;
  const prefix = process.env.T3_SMOKE_CLI ? [] : [`${tree}/apps/server/src/bin.ts`];
  const result = await execute(executable, [...prefix, 'thread', ...args, '--base-dir', home, '--json'], {
    cwd: tree, timeout: 90000, maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
};
const mcp = async (action) => Effect.runPromise(withOwnerMcpTools('proof', { baseDir: Option.some(home) }, action).pipe(
  Effect.provideService(GlobalFlag.LogLevel, Option.none()), Effect.provide(Net.layer), Effect.provide(NodeServices.layer),
));
const call = (tools, name, args) => tools.call(name, args, Schema.Unknown);
const threads = [];
try {
  const before = await mcp((tools) => call(tools, 't3_thread_list', { allProjects: true, statuses: ['failed'], includeSubagents: true, limit: 100 }));
  evidence.failedBefore = before;
  const project = await mcp((tools) => call(tools, 't3_project_create', {
    title: 'Send receipts proof workspace', workspaceRoot: `${home}/proof-workspace-${Date.now()}`, createWorkspaceRootIfMissing: true,
  }));
  const projectId = project.id;
  const launch = await mcp((tools) => call(tools, 't3_thread_launch', {
    title: 'Send receipts isolated dogfood', projectId,
    modelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol' },
    runtimeMode: 'full-access', clientRequestId: `proof-launch-${Date.now()}`,
  }));
  const threadId = launch.threadId;
  threads.push(threadId);
  evidence.threadId = threadId;
  const claude = await mcp((tools) => call(tools, 't3_thread_launch', {
    title: 'Send receipts Claude MCP isolated dogfood', projectId,
    modelSelection: { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' },
    runtimeMode: 'full-access', clientRequestId: `proof-claude-${Date.now()}`,
  }));
  threads.push(claude.threadId);
  const message = 'Reply with exactly RECEIPT_OK. Do not use any tools.';
  try {
    await cli('send', '--request-id', 'fault-cli', threadId, message);
    assert.fail('CLI fault did not fail');
  } catch (error) {
    assert(error.stderr?.includes('504'), error.stderr ?? String(error));
    evidence.failures.push({ boundary: 'cli', code: error.code, stderr: error.stderr });
  }
  const cliRetries = await Promise.all(Array.from({ length: 6 }, () => cli('send', '--request-id', 'fault-cli', threadId, message)));
  assert.equal(new Set(cliRetries.map((item) => item.messageId)).size, 1);
  assert.equal(new Set(cliRetries.map((item) => item.runId)).size, 1);
  assert.equal(new Set(cliRetries.map((item) => item.receipt.commandId)).size, 1);
  assert.equal(new Set(cliRetries.map((item) => item.receipt.sequence)).size, 1);
  assert(cliRetries.every((item) => item.receipt.replayed === true));
  evidence.receipts.push({ boundary: 'cli', retries: cliRetries });
  await mcp((tools) => Effect.gen(function* () {
    const request = { threadId: claude.threadId, message, mode: 'queue', clientRequestId: 'fault-mcp' };
    const fault = yield* call(tools, 't3_thread_send', request).pipe(Effect.result);
    assert.equal(fault._tag, 'Failure');
    const retries = yield* Effect.all(Array.from({ length: 8 }, () => call(tools, 't3_thread_send', request)), { concurrency: 8 });
    assert.equal(new Set(retries.map((item) => item.messageId)).size, 1);
    assert.equal(new Set(retries.map((item) => item.runId)).size, 1);
    assert.equal(new Set(retries.map((item) => item.receipt.sequence)).size, 1);
    assert(retries.every((item) => item.receipt.replayed === true));
    evidence.receipts.push({ boundary: 'mcp', retries });
    const conflict = yield* call(tools, 't3_thread_send', { ...request, message: 'DIFFERENT MESSAGE' }).pipe(Effect.result);
    assert.equal(conflict._tag, 'Failure');
    const changedMode = yield* call(tools, 't3_thread_send', { ...request, mode: 'restart' }).pipe(Effect.result);
    assert.equal(changedMode._tag, 'Failure');
    evidence.assertions.push('different payload with same request id refused');
  }));
  for (const group of evidence.receipts) {
    const sent = group.retries[0];
    const link = new URL(sent.link);
    assert.equal(link.protocol, 'http:');
    assert.equal(decodeURIComponent(link.pathname.split('/').at(-1)), sent.threadId);
    assert.equal(link.host, new URL(upstream).host);
    evidence.assertions.push(`${group.boundary}: upstream openable HTTP thread link preserved`);
    const waited = await mcp((tools) => call(tools, 't3_thread_wait', { threadId: sent.threadId, runId: sent.runId, timeoutMs: 120000 }));
    group.waited = waited;
    assert.equal(waited.status, 'completed', JSON.stringify(waited));
    const read = await mcp((tools) => call(tools, 't3_thread_read', { threadId: sent.threadId, limit: 100, maxCharsPerItem: 2000, runLimit: 50 }));
    group.read = read;
    const messageId = group.retries[0].messageId;
    assert.equal(read.items.filter((item) => item.type === 'user_message' && item.messageId === messageId).length, 1);
    evidence.assertions.push(`${group.boundary}: exactly one durable delivery after timeout and ${group.retries.length} simultaneous retries`);
    await mcp((tools) => call(tools, 't3_thread_organize', { threadId: sent.threadId, action: 'archive' }));
    const archivedReplay = group.boundary === 'cli'
      ? await cli('send', '--request-id', 'fault-cli', sent.threadId, message)
      : await mcp((tools) => call(tools, 't3_thread_send', { threadId: sent.threadId, message, mode: 'queue', clientRequestId: 'fault-mcp' }));
    assert.equal(archivedReplay.messageId, sent.messageId);
    assert.equal(archivedReplay.receipt.sequence, sent.receipt.sequence);
    assert.equal(archivedReplay.receipt.replayed, true);
    group.archivedReplay = archivedReplay;
    await mcp((tools) => call(tools, 't3_thread_organize', { threadId: sent.threadId, action: 'unarchive' }));
  }
  assert.equal(dropped.size, 2);
  evidence.failedAfter = await mcp((tools) => Effect.gen(function* () {
    const real = yield* call(tools, 't3_thread_list', { allProjects: true, statuses: ['failed'], limit: 100 });
    const children = yield* call(tools, 't3_thread_list', { allProjects: true, statuses: ['failed'], onlySubagents: true, limit: 100 });
    assert(real.threads.every((item) => item.relationshipToParent !== 'subagent'));
    assert(children.threads.every((item) => item.relationshipToParent === 'subagent'));
    return { real, children };
  }));
  for (const threadId of threads) await mcp((tools) => call(tools, 't3_thread_organize', { threadId, action: 'settle' }));
  evidence.pass = true;
} catch (error) {
  evidence.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await writeFile(runtimePath, JSON.stringify(runtime));
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  evidence.completedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ pass: evidence.pass ?? false, output, error: evidence.error, assertions: evidence.assertions }));
}
