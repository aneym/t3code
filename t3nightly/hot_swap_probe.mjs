import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import nodeHttp from "node:http";

const HTTP_DEADLINE_MS = 8000;

export async function monitor(context) {
  const { opts, Effect, Stream, layers } = context;
  const started = performance.now();
  const data = { httpSamples: 0, refusedConnections: 0, httpFailures: 0, maxHttpGapMs: 0, flipGapMs: null, servedVersions: [], httpObservations: [], keepAlive: { requests: 0, reused: 0, failures: 0, errors: [], versions: [], sockets: [] }, wsConnections: 0, wsFailures: 0, streamFailures: [], snapshots: [], sequences: [], resnapshots: 0, ready: false, presentations: [], presentationViolations: [], handoffCalls: [], handoffReplies: [], handoffSettlements: [], handoffEvents: [], sessions: [], subscriptions: [], receivedEvents: [] };
  const interval = Math.max(10, Number(opts["interval-ms"] ?? 100));
  let lastOk = started;
  data.httpProbeIntervalMs = interval;
  const elapsed = () => Math.round(performance.now() - started);
  const streamed = opts["stream-http"] === "true";
  if (streamed) {
    data.httpSampleLog = `${opts.output}.http.jsonl`;
    data.httpObservationWindow = 128;
  }
  const sample = (kind, row) => {
    if (streamed) appendFileSync(data.httpSampleLog, JSON.stringify({ kind, ...row }) + "\n");
    const rows = kind === "response" ? data.httpObservations : (data.httpErrors ??= []);
    rows.push(row);
    if (streamed && rows.length > 128) rows.shift();
  };
  let lastSaved = -Infinity;
  let lastSnapshot = -Infinity;
  const save = (force = false) => {
    if (!force && performance.now() - lastSaved < Number(opts["save-interval-ms"] ?? 0)) return;
    lastSaved = performance.now();
    if (streamed) {
      const status = { servedVersions: data.servedVersions, latestHttpObservation: data.httpObservations.at(-1), subscriptions: data.subscriptions.length, ready: data.ready, elapsedMs: elapsed() };
      writeFileSync(`${opts.output}.status.next`, JSON.stringify(status));
      renameSync(`${opts.output}.status.next`, `${opts.output}.status`);
      if (!force && performance.now() - lastSnapshot < 5000) return;
      lastSnapshot = performance.now();
    }
    writeFileSync(`${opts.output}.next`, JSON.stringify({ ...data, elapsedMs: elapsed() }));
    renameSync(`${opts.output}.next`, opts.output);
  };
  const stopped = async () => {
    while (!existsSync(opts.stop)) await delay(interval);
  };
  const http = async () => {
    while (!existsSync(opts.stop)) {
      const requestStarted = performance.now();
      try {
        const environment = await new Promise((resolve, reject) => {
          const request = nodeHttp.get(`${opts.origin}/.well-known/t3/environment`, { agent: false, timeout: HTTP_DEADLINE_MS }, (response) => {
            let body = "";
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => { try { if (response.statusCode !== 200) throw new Error("health status"); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
            response.on("error", reject);
          });
          request.on("timeout", () => request.destroy(new Error("fresh HTTP deadline")));
          request.on("error", reject);
        });
        sample("response", { at: new Date().toISOString(), atMs: elapsed(), version: environment.serverVersion, startedAtMs: Math.round(requestStarted - started), latencyMs: Math.round(performance.now() - requestStarted) });
        const now = performance.now();
        const gap = Math.round(now - lastOk);
        data.maxHttpGapMs = Math.max(data.maxHttpGapMs, gap);
        if (data.servedVersions.length && data.servedVersions.at(-1).version !== environment.serverVersion) data.flipGapMs = gap;
        lastOk = now;
        if (data.servedVersions.at(-1)?.version !== environment.serverVersion) data.servedVersions.push({ version: environment.serverVersion, atMs: elapsed() });
      } catch (error) {
        sample("error", { at: new Date().toISOString(), atMs: elapsed(), code: error?.code ?? error?.cause?.code ?? "HTTP_FAILED", latencyMs: Math.round(performance.now() - requestStarted) });
        data.httpFailures++;
        if (error?.code === "ECONNREFUSED" || error?.cause?.code === "ECONNREFUSED") data.refusedConnections++;
      }
      data.httpSamples++;
      save();
      await delay(interval);
    }
  };
  const keepAlive = async () => {
    const agent = new nodeHttp.Agent({ keepAlive: true, maxSockets: 1 });
    const sockets = new WeakMap();
    try {
      while (!existsSync(opts.stop)) {
        await new Promise((resolve) => {
          const request = nodeHttp.get(`${opts.origin}/.well-known/t3/environment`, { agent, timeout: HTTP_DEADLINE_MS }, (response) => {
            let body = "";
            response.on("data", (chunk) => { body += chunk; });
            response.on("end", () => {
              data.keepAlive.requests++;
              if (request.reusedSocket) data.keepAlive.reused++;
              try {
                const version = JSON.parse(body).serverVersion;
                const socket = request.socket;
                if (socket) {
                  let row = sockets.get(socket);
                  if (!row) { row = { id: data.keepAlive.sockets.length + 1, versions: [], replies: 0 }; sockets.set(socket, row); data.keepAlive.sockets.push(row); }
                  row.replies++;
                  if (!row.versions.includes(version)) row.versions.push(version);
                }
                if (data.keepAlive.versions.at(-1) !== version) data.keepAlive.versions.push(version);
              } catch { data.keepAlive.failures++; }
              resolve();
            });
            response.on("error", () => { data.keepAlive.failures++; resolve(); });
          });
          request.on("timeout", () => request.destroy(new Error("keep-alive deadline")));
          request.on("error", (error) => { data.keepAlive.failures++; data.keepAlive.errors.push({ atMs: elapsed(), code: error.code ?? null, reusedSocket: request.reusedSocket }); resolve(); });
        });
        await delay(interval);
      }
    } finally { agent.destroy(); }
  };
  const websocket = async () => {
    const { supervise } = await import("./hot_swap_supervisor.mjs");
    await supervise({ ...context, data, save, elapsed, stopped });
  };
  await Promise.all([http(), keepAlive(), websocket()]);
  data.maxHttpGapMs = Math.max(data.maxHttpGapMs, Math.round(performance.now() - lastOk));
  save(true);
  return data;
}
