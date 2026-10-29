import { queueDrain } from "./gate_queue.mjs";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [mode, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, "")] = rest[i + 1];
const tree = realpathSync(opts.tree);
const src = `${tree}/packages/client-runtime/src`;
const effectRoot = realpathSync(`${tree}/apps/mobile/node_modules/effect`);
const load = (path) => import(pathToFileURL(path).href);

const Effect = await load(`${effectRoot}/dist/Effect.js`);
const Layer = await load(`${effectRoot}/dist/Layer.js`);
const Stream = await load(`${effectRoot}/dist/Stream.js`);
const Socket = await load(`${effectRoot}/dist/socket/Socket.js`);
const Onboarding = await load(`${src}/connection/onboarding.ts`);
const Model = await load(`${src}/connection/model.ts`);
const Capabilities = await load(`${src}/platform/capabilities.ts`);
const Remote = await load(`${src}/authorization/remote.ts`);
const Descriptor = await load(`${src}/environment/descriptor.ts`);
const Http = await load(`${src}/rpc/http.ts`);
const RpcSession = await load(`${src}/rpc/session.ts`);
const Compatibility = await load(`${src}/connection/compatibility.ts`);
const Registry = await load(`${src}/connection/registry.ts`);

const metadata = {
  label: "T3 Code Mobile",
  deviceType: "mobile",
  os: "iOS",
  surface: "mobile",
  appVersion: "t3nightly-gate",
};

const layers = Layer.mergeAll(
  Http.layerRemoteHttpClient(globalThis.fetch),
  RpcSession.layer({}).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
  Layer.succeed(Capabilities.ClientPresentation, Capabilities.ClientPresentation.of({ metadata })),
  Layer.succeed(Registry.EnvironmentRegistry, { assertKnownAddress: () => Effect.void }),
);

const pairingUrl = () => {
  const text = readFileSync(opts["pairing-file"], "utf8");
  const match = text.match(/^Pairing URL: (\S+)$/m);
  if (!match) throw new Error("no 'Pairing URL:' line in t3 pair output");
  return match[1];
};

const openSession = Effect.fnUntraced(function* (registration) {
  const token = registration.credential.token;
  const { httpBaseUrl, wsBaseUrl } = registration.profile;
  const state = yield* Remote.fetchRemoteSessionState({ httpBaseUrl, bearerToken: token });
  if (state.authenticated !== true) throw new Error("bearer session is not authenticated");
  const descriptor = yield* Descriptor.fetchRemoteEnvironmentDescriptor({ httpBaseUrl });
  const incompatible = Compatibility.orchestrationProtocolCompatibilityError(descriptor);
  if (incompatible !== null) return yield* incompatible;
  const ticketedUrl = yield* Remote.resolveRemoteWebSocketConnectionUrl({
    wsBaseUrl,
    httpBaseUrl,
    bearerToken: token,
    clientMetadata: metadata,
    connectionMethod: "direct",
  });
  const factory = yield* RpcSession.RpcSessionFactory;
  const session = yield* factory.connect({
    environmentId: registration.target.environmentId,
    label: registration.target.label,
    httpBaseUrl,
    socketUrl: Compatibility.appendOrchestrationProtocol(ticketedUrl),
    httpAuthorization: { _tag: "Bearer", token },
    target: registration.target,
  });
  const config = yield* session.initialConfig;
  yield* session.probe;
  return { session, config, descriptor };
});

const pairedSession = Effect.fnUntraced(function* () {
  const registration = yield* Onboarding.preparePairingRegistration({ pairingUrl: pairingUrl() });
  return { registration, ...(yield* openSession(registration)) };
});

const bearerSession = Effect.fnUntraced(function* () {
  const httpBaseUrl = opts.origin;
  const descriptor = yield* Descriptor.fetchRemoteEnvironmentDescriptor({ httpBaseUrl });
  const registration = {
    target: new Model.BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId: `bearer:${descriptor.environmentId}:${new URL(httpBaseUrl).origin}`,
    }),
    profile: { httpBaseUrl, wsBaseUrl: httpBaseUrl.replace(/^http/, "ws") },
    credential: { token: readFileSync(opts["bearer-file"], "utf8").trim() },
  };
  return yield* openSession(registration);
});

const firstOf = (stream, kind, timeout) =>
  stream.pipe(
    Stream.filter((item) => item.kind === kind),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((items) => Array.from(items)[0]),
    Effect.timeout(timeout),
  );

const settledStatuses = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

const holds = (thread) =>
  (thread.pendingBackgroundTasks ?? []).some((task) => task.awaited === true);

const queueProjection = mode === "queue-drain"
  ? await load(`${src}/state/orchestrationV2Projection.ts`)
  : null;

const programs = {
  "restart-rpc": Effect.fnUntraced(function* () {
    const { session } = yield* bearerSession();
    const methods = { prepare: "server.prepareRestart", abort: "server.abortRestart", import: "server.importRestartHandoff", status: "server.getRestartStatus" };
    const method = methods[opts.operation];
    if (!method) throw new Error("unsupported restart operation");
    const request = JSON.parse(readFileSync(opts["request-file"], "utf8"));
    const receipt = yield* session.client[method](request);
    return { receipt };
  }),
  "queue-drain": Effect.fnUntraced(function* () {
    const { session, config } = yield* pairedSession();
    const { applyOrchestrationV2ProjectionEvent: applyEvent } = queueProjection;
    return yield* queueDrain({ session, config, opts, Effect, Stream, applyEvent });
  }),
  session: Effect.fnUntraced(function* () {
    const { descriptor, config } = yield* bearerSession();
    return {
      serverVersion: descriptor.serverVersion,
      environmentId: descriptor.environmentId,
      providers: (config.providers ?? []).map((provider) => provider.instanceId ?? provider.id),
      settings: Object.fromEntries(
        ["sidebarAutoSettleAfterDays", "sidebarAutoSettleOnMerge", "continueThreadsAfterServerUpdate", "autoResumeLimitedThreads", "idleCompaction"].map((key) => [key, config.settings?.[key]]),
      ),
    };
  }),
  pair: Effect.fnUntraced(function* () {
    const { registration, config } = yield* pairedSession();
    const reuse = yield* Effect.exit(Onboarding.preparePairingRegistration({ pairingUrl: pairingUrl() }));
    return {
      reuseRejected: reuse._tag === "Failure",
      environmentId: registration.target.environmentId,
      httpBaseUrl: registration.profile.httpBaseUrl,
      providers: (config.providers ?? []).length,
    };
  }),
  mobile: Effect.fnUntraced(function* () {
    const { session } = yield* pairedSession();
    const shell = yield* firstOf(session.client["orchestration.subscribeShell"]({}), "snapshot", "60 seconds");
    const threads = shell.snapshot.threads;
    if (threads.length === 0) throw new Error("shell snapshot listed no threads");
    const picked = threads.toSorted((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    const detail = yield* firstOf(
      session.client["orchestration.subscribeThread"]({ threadId: picked.id }),
      "snapshot",
      "60 seconds",
    );
    if (detail.projection.thread.id !== picked.id) throw new Error("thread stream returned another thread");
    return {
      projects: shell.snapshot.projects.length,
      threads: threads.length,
      openedThread: picked.id,
      messages: detail.projection.messages.length,
      snapshotSequence: detail.snapshotSequence,
    };
  }),
  bgwait: Effect.fnUntraced(function* () {
    const { session } = yield* pairedSession();
    const threadId = opts.thread;
    const started = Date.now();
    const samples = [];
    let current = null;
    let heldAt = null;
    let heldRunId = null;
    let releasedAt = null;
    let idleBeforeHold = null;
    const idleGaps = [];
    const observe = (thread) => {
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const sample = { t: seconds, status: thread.status, active: thread.activeRunId !== null, held: holds(thread) };
      const last = samples.at(-1);
      if (!last || last.status !== sample.status || last.active !== sample.active || last.held !== sample.held) samples.push(sample);
      const working = sample.active || sample.held;
      if (sample.held && heldAt === null) {
        heldAt = seconds;
        heldRunId = thread.latestRunId;
      }
      if (heldAt === null && !working && idleBeforeHold === null) idleBeforeHold = seconds;
      if (heldAt !== null && !sample.held && releasedAt === null) releasedAt = seconds;
      if (heldAt !== null && !working && thread.latestRunId === heldRunId) idleGaps.push(seconds);
      current = thread;
      return heldAt !== null && !working && thread.latestRunId !== heldRunId && settledStatuses.has(thread.status);
    };
    yield* session.client["orchestration.subscribeShell"]({}).pipe(
      Stream.flatMap((item) =>
        item.kind === "snapshot"
          ? Stream.fromIterable(item.snapshot.threads.filter((thread) => thread.id === threadId))
          : item.kind === "thread.updated" && item.thread.id === threadId
            ? Stream.make(item.thread)
            : Stream.empty,
      ),
      Stream.takeUntil(observe),
      Stream.runDrain,
      Effect.timeout(`${Number(opts.timeout ?? 180)} seconds`),
    );
    const detail = yield* firstOf(session.client["orchestration.subscribeThread"]({ threadId }), "snapshot", "60 seconds");
    const reply = detail.projection.messages.filter((message) => message.role === "assistant").map((message) => message.text).join("\n");
    const result = {
      samples,
      heldAtSeconds: heldAt,
      releasedAtSeconds: releasedAt,
      idleBeforeHoldAtSeconds: idleBeforeHold,
      idleWhileHeldRunAtSeconds: idleGaps,
      finalStatus: current?.status ?? null,
      markerInReply: reply.includes(opts.marker),
      runs: detail.projection.runs?.length ?? null,
    };
    const fail = (message) => Object.assign(new Error(message), { result });
    if (idleBeforeHold !== null) throw fail("thread went idle before the agent marked its background task");
    if (releasedAt === null || releasedAt < Number(opts["min-release"] ?? 0)) throw fail(`hold released at ${releasedAt}s, before the task could finish`);
    if (!result.markerInReply) throw fail("assistant reply lacks the background task output");
    if (result.finalStatus !== "completed") throw fail(`thread settled as ${result.finalStatus}`);
    return result;
  }),
};

const program = programs[mode];
if (!program) {
  console.error(`usage: client.mjs session|pair|mobile|bgwait|queue-drain --tree DIR ...`);
  process.exit(2);
}
try {
  const result = await Effect.runPromise(program().pipe(Effect.scoped, Effect.provide(layers)));
  console.log(JSON.stringify({ ok: true, ...result }));
  process.exit(0);
} catch (error) {
  const message = String(error?.message ?? error).replace(/(token|ticket)=[^&\s"]+/gi, "$1=REDACTED");
  console.log(JSON.stringify({ ok: false, error: message, ...(error?.result ?? {}) }));
  process.exit(1);
}
