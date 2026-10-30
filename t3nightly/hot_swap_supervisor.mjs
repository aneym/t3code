export async function supervise({ opts, Effect, Stream, Layer, load, src, effectRoot, layers, Model, Remote, Descriptor, Compatibility, RpcSession, data, save, elapsed, stopped }) {
  const [Supervisor, Driver, Resolver, Connectivity, Wakeups, Presentation, Option, SubscriptionRef] = await Promise.all([
    load(`${src}/connection/supervisor.ts`), load(`${src}/connection/driver.ts`), load(`${src}/connection/resolver.ts`),
    load(`${src}/connection/connectivity.ts`), load(`${src}/connection/wakeups.ts`), load(`${src}/connection/presentation.ts`),
    load(`${effectRoot}/dist/Option.js`), load(`${effectRoot}/dist/SubscriptionRef.js`),
  ]);
  const { readFileSync } = await import("node:fs");
  const token = readFileSync(opts["bearer-file"], "utf8").trim();
  const first = await Effect.runPromise(Descriptor.fetchRemoteEnvironmentDescriptor({ httpBaseUrl: opts.origin }).pipe(Effect.provide(layers)));
  const target = new Model.BearerConnectionTarget({ environmentId: first.environmentId, label: first.label, connectionId: `rehearsal:${first.environmentId}:${opts.origin}` });
  const entry = { target, profile: Option.none(), enabled: true };
  const prepare = Effect.fnUntraced(function* () {
    const descriptor = yield* Descriptor.fetchRemoteEnvironmentDescriptor({ httpBaseUrl: opts.origin });
    if (descriptor.environmentId !== target.environmentId) throw new Error("rehearsal environment identity changed");
    const incompatible = Compatibility.orchestrationProtocolCompatibilityError(descriptor);
    if (incompatible !== null) return yield* incompatible;
    const socketUrl = yield* Remote.resolveRemoteWebSocketConnectionUrl({ httpBaseUrl: opts.origin, wsBaseUrl: opts.origin.replace(/^http/, "ws"), bearerToken: token, connectionMethod: "direct", clientMetadata: { label: "Rehearsal supervisor", deviceType: "mobile", os: "iOS", surface: "mobile", appVersion: "t3nightly-gate" } });
    return { environmentId: target.environmentId, label: target.label, target, httpBaseUrl: opts.origin, socketUrl: Compatibility.appendOrchestrationProtocol(socketUrl), httpAuthorization: { _tag: "Bearer", token } };
  });
  const program = Effect.scoped(Effect.gen(function* () {
    const factory = yield* RpcSession.RpcSessionFactory;
    const connect = (connection) => factory.connect(connection).pipe(Effect.map((session) => {
      data.wsConnections++;
      const client = new Proxy(session.client, { get(object, method) {
        const original = Reflect.get(object, method);
        if (method !== "subscribeServerLifecycle" && method !== "server.probe") return original;
        return (input) => {
          if (typeof input?.handoffClientId === "string") {
            data.handoffCalls.push({ atMs: elapsed(), method, clientId: input.handoffClientId, sequence: input.handoffSequence ?? null });
            save();
          }
          const result = original(input);
          if (method !== "subscribeServerLifecycle") return result.pipe(Effect.tap(() => Effect.sync(() => {
            if (input?.handoffSequence !== undefined) { data.handoffReplies.push({ atMs: elapsed(), clientId: input.handoffClientId, sequence: input.handoffSequence }); save(); }
          })));
          return result.pipe(Stream.tap((event) => Effect.sync(() => {
            if (event.type === "handoff") { data.handoffEvents.push({ atMs: elapsed(), sequence: event.sequence, reconnectWithinMs: event.payload.reconnectWithinMs }); save(); }
          })));
        };
      } });
      return { ...session, client };
    }));
    const driver = yield* Driver.make.pipe(Effect.provideService(Resolver.ConnectionResolver, Resolver.ConnectionResolver.of({ prepare, prepareForUpdate: prepare })), Effect.provideService(RpcSession.RpcSessionFactory, RpcSession.RpcSessionFactory.of({ connect })));
    const supervisor = yield* Supervisor.make(entry, { initiallyDesired: true }).pipe(
      Effect.provideService(Driver.ConnectionDriver, driver),
      Effect.provideService(Connectivity.Connectivity, { status: Effect.succeed("online"), changes: Stream.never }),
      Effect.provideService(Wakeups.ConnectionWakeups, { changes: Stream.never }),
    );
    yield* SubscriptionRef.changes(supervisor.state).pipe(Stream.runForEach((state) => Effect.sync(() => {
      const presentation = Presentation.presentConnectionState(state);
      const firstConnected = data.presentations.some((item) => item.presentation.phase === "connected");
      const row = { atMs: elapsed(), state: { phase: state.phase, stage: state.stage, generation: state.generation, attempt: state.attempt }, presentation };
      data.presentations.push(row);
      if (firstConnected && ["offline", "reconnecting", "error", "unsupported"].includes(presentation.phase)) data.presentationViolations.push(row);
      save();
    })), Effect.forkScoped);
    let cursor;
    yield* SubscriptionRef.changes(supervisor.session).pipe(Stream.switchMap((option) => {
      if (Option.isNone(option)) return Stream.empty;
      const session = option.value;
      return Stream.unwrap(Effect.sync(() => session.client["orchestration.subscribeThread"]({ threadId: opts.thread, ...(cursor === undefined ? {} : { afterSequence: cursor }) }))).pipe(Stream.tap((item) => Effect.sync(() => {
        if (item.kind === "snapshot") {
          if (cursor !== undefined) data.resnapshots++;
          data.snapshots.push(item.snapshotSequence);
          cursor = item.snapshotSequence;
          data.ready = true;
        } else if (item.sequence !== undefined) {
          if (!data.sequences.includes(item.sequence)) data.sequences.push(item.sequence);
          cursor = Math.max(cursor ?? 0, item.sequence);
        }
        save();
      })), Stream.catchCause(() => { data.wsFailures++; save(); return Stream.empty; }));
    }), Stream.runDrain, Effect.forkScoped);
    yield* Effect.promise(stopped);
  })).pipe(Effect.provide(layers));
  await Effect.runPromise(program);
}
