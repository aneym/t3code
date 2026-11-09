// @effect-diagnostics nodeBuiltinImport:off -- The broker needs an IPC channel, which Effect ChildProcess lacks.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

const BROKER_SOURCE = `
const { spawn } = require("node:child_process");
const kids = new Map();
const send = (m) => { if (process.connected) process.send(m); };
const signalGroup = (c, s) => { try { process.kill(-c.pid, s); } catch { try { c.kill(s); } catch {} } };
process.on("message", (m) => {
  if (m.t === "spawn") {
    let c;
    try {
      c = spawn(m.command, m.args, { cwd: m.cwd, env: m.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      send({ id: m.id, t: "error", code: e && e.code, message: String(e && e.message) });
      return;
    }
    kids.set(m.id, c);
    c.on("error", (e) => { send({ id: m.id, t: "error", code: e.code, message: String(e.message) }); });
    c.on("spawn", () => send({ id: m.id, t: "spawned", pid: c.pid }));
    c.stdin.on("error", () => {});
    c.stdout.on("data", (d) => send({ id: m.id, t: "out", fd: 1, d }));
    c.stderr.on("data", (d) => send({ id: m.id, t: "out", fd: 2, d }));
    c.on("close", (code, signal) => { kids.delete(m.id); send({ id: m.id, t: "exit", code, signal }); });
    return;
  }
  const c = kids.get(m.id);
  if (c === undefined) return;
  if (m.t === "in") c.stdin.write(m.d);
  else if (m.t === "end") c.stdin.end();
  else if (m.t === "kill") {
    signalGroup(c, m.signal);
    if (m.forceAfter !== undefined) setTimeout(() => { if (kids.has(m.id)) signalGroup(c, "SIGKILL"); }, m.forceAfter).unref();
  }
});
process.on("disconnect", () => { for (const c of kids.values()) signalGroup(c, "SIGKILL"); process.exit(0); });
send({ t: "ready" });
`;

type ExitResult = readonly [code: number | null, signal: string | null];
type OutputQueue = Queue.Queue<Uint8Array, PlatformError.PlatformError | Cause.Done>;

interface Job {
  readonly spawned: Deferred.Deferred<number, PlatformError.PlatformError>;
  readonly stdout: OutputQueue;
  readonly stderr: OutputQueue;
  readonly exit: Deferred.Deferred<ExitResult, PlatformError.PlatformError>;
}

type BrokerMessage =
  | { readonly t: "ready" }
  | { readonly id: number; readonly t: "spawned"; readonly pid: number }
  | { readonly id: number; readonly t: "error"; readonly code?: string; readonly message: string }
  | { readonly id: number; readonly t: "out"; readonly fd: 1 | 2; readonly d: Uint8Array }
  | {
      readonly id: number;
      readonly t: "exit";
      readonly code: number | null;
      readonly signal: string | null;
    };

const brokerError = (method: string, description: string, code?: string) =>
  PlatformError.systemError({
    _tag: code === "ENOENT" ? "NotFound" : code === "EACCES" ? "PermissionDenied" : "Unknown",
    module: "GitSpawnBroker",
    method,
    description,
  });

const isBrokerCommand = (command: ChildProcess.Command): command is ChildProcess.StandardCommand =>
  command._tag === "StandardCommand" &&
  /(?:^|\/)git$/.test(command.command) &&
  !command.options.shell &&
  command.options.stdin === undefined &&
  command.options.stdout === undefined &&
  command.options.stderr === undefined &&
  command.options.additionalFds === undefined &&
  command.options.detached !== false;

const resolveEnv = (options: ChildProcess.CommandOptions) => {
  const merged = options.extendEnv
    ? { ...process.env, ...options.env }
    : (options.env ?? process.env);
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
};

const makeBroker = () => {
  const jobs = new Map<number, Job>();
  let nextId = 0;
  let disabled = false;
  let current:
    | { readonly proc: NodeChildProcess.ChildProcess; readonly ready: Deferred.Deferred<boolean> }
    | undefined;

  const setReferenced = (proc: NodeChildProcess.ChildProcess) => {
    if (jobs.size > 0) {
      proc.ref();
      proc.channel?.ref();
    } else {
      proc.unref();
      proc.channel?.unref();
    }
  };

  const finishJob = (id: number) => {
    jobs.delete(id);
    if (current !== undefined) setReferenced(current.proc);
  };

  const failJob = (id: number, job: Job, error: PlatformError.PlatformError) => {
    Deferred.doneUnsafe(job.spawned, Exit.fail(error));
    Queue.endUnsafe(job.stdout);
    Queue.endUnsafe(job.stderr);
    finishJob(id);
    Deferred.doneUnsafe(job.exit, Exit.fail(error));
  };

  const receive = (message: BrokerMessage) => {
    if (message.t === "ready") {
      if (current !== undefined) Deferred.doneUnsafe(current.ready, Exit.succeed(true));
      return;
    }
    const job = jobs.get(message.id);
    if (job === undefined) return;
    switch (message.t) {
      case "spawned":
        Deferred.doneUnsafe(job.spawned, Exit.succeed(message.pid));
        return;
      case "error":
        failJob(message.id, job, brokerError("spawn", message.message, message.code));
        return;
      case "out":
        Queue.offerUnsafe(message.fd === 1 ? job.stdout : job.stderr, message.d);
        return;
      case "exit": {
        const result: ExitResult = [message.code, message.signal];
        Queue.endUnsafe(job.stdout);
        Queue.endUnsafe(job.stderr);
        finishJob(message.id);
        Deferred.doneUnsafe(job.exit, Exit.succeed(result));
      }
    }
  };

  const dropAll = (proc: NodeChildProcess.ChildProcess) => {
    if (current?.proc !== proc) return;
    const wasReady = Deferred.isDoneUnsafe(current.ready);
    Deferred.doneUnsafe(current.ready, Exit.succeed(false));
    if (!wasReady) disabled = true;
    current = undefined;
    const error = brokerError("broker", "git spawn broker exited");
    for (const [id, job] of jobs) failJob(id, job, error);
  };

  const connect = () => {
    if (current !== undefined) return current;
    const proc = NodeChildProcess.spawn(process.execPath, ["-e", BROKER_SOURCE], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      serialization: "advanced",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const connection = { proc, ready: Deferred.makeUnsafe<boolean>() };
    current = connection;
    proc.on("message", receive);
    proc.on("error", () => dropAll(proc));
    proc.on("exit", () => dropAll(proc));
    setReferenced(proc);
    return connection;
  };

  const post = (message: object) =>
    Effect.sync(() => {
      if (current?.proc.connected) current.proc.send(message);
    });

  const shutdown = Effect.sync(() => {
    const proc = current?.proc;
    if (proc === undefined) return;
    dropAll(proc);
    if (proc.connected) proc.disconnect();
  });

  const ready = Effect.suspend(() =>
    disabled ? Effect.succeed(false) : Deferred.await(connect().ready),
  );

  const spawn = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
    const id = nextId++;
    const job: Job = {
      spawned: Deferred.makeUnsafe(),
      stdout: yield* Queue.unbounded<Uint8Array, PlatformError.PlatformError | Cause.Done>(),
      stderr: yield* Queue.unbounded<Uint8Array, PlatformError.PlatformError | Cause.Done>(),
      exit: Deferred.makeUnsafe(),
    };
    const options = command.options;
    const forceAfter =
      options.forceKillAfter === undefined
        ? undefined
        : Duration.toMillis(Duration.fromInputUnsafe(options.forceKillAfter));
    const terminate = (signal: string | undefined, force: number | undefined) =>
      Effect.andThen(
        post({ id, t: "kill", signal: signal ?? "SIGTERM", forceAfter: force ?? 1_000 }),
        Effect.ignore(Deferred.await(job.exit)),
      );

    const pid = yield* Effect.acquireRelease(
      Effect.suspend(() => {
        const proc = current?.proc;
        if (proc?.connected !== true) {
          return Effect.fail(brokerError("spawn", "git spawn broker is not connected"));
        }
        jobs.set(id, job);
        setReferenced(proc);
        proc.send({
          id,
          t: "spawn",
          command: command.command,
          args: command.args,
          cwd: options.cwd,
          env: resolveEnv(options),
        });
        return Deferred.await(job.spawned);
      }),
      () =>
        Deferred.isDoneUnsafe(job.exit) ? Effect.void : terminate(options.killSignal, forceAfter),
    );

    const exitCode = Effect.flatMap(Deferred.await(job.exit), ([code, signal]) =>
      code !== null
        ? Effect.succeed(ChildProcessSpawner.ExitCode(code))
        : Effect.fail(
            brokerError("exitCode", `Process interrupted due to receipt of signal: '${signal}'`),
          ),
    );
    const stdout = Stream.fromQueue(job.stdout);
    const stderr = Stream.fromQueue(job.stderr);
    const stdin = Sink.forEach((chunk: Uint8Array) => post({ id, t: "in", d: chunk })).pipe(
      Sink.ensuring(post({ id, t: "end" })),
    );

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(pid),
      exitCode,
      isRunning: Effect.sync(() => !Deferred.isDoneUnsafe(job.exit)),
      kill: (killOptions) =>
        terminate(
          killOptions?.killSignal,
          killOptions?.forceKillAfter === undefined
            ? undefined
            : Duration.toMillis(Duration.fromInputUnsafe(killOptions.forceKillAfter)),
        ),
      stdin,
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  });

  return { ready, spawn, shutdown };
};

export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const upstream = yield* ChildProcessSpawner.ChildProcessSpawner;
    const brokered = (yield* HostProcess.Platform) !== "win32";
    const broker = makeBroker();
    yield* Effect.addFinalizer(() => broker.shutdown);
    return ChildProcessSpawner.make((command) =>
      brokered && isBrokerCommand(command)
        ? Effect.flatMap(broker.ready, (ready) =>
            ready ? broker.spawn(command) : upstream.spawn(command),
          )
        : upstream.spawn(command),
    );
  }),
);

export const layerNode = layer.pipe(Layer.provideMerge(NodeServices.layer));
