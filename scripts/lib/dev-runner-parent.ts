import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";

const readParents = Effect.fn("dev-runner.readParents")(function* (
  pids: ReadonlyArray<number> | undefined,
) {
  const child = yield* ChildProcess.make(
    "ps",
    pids ? ["-o", "pid=,ppid=", "-p", pids.join(",")] : ["-axo", "pid=,ppid="],
    {
      stdin: "ignore",
    },
  );
  const stdout = yield* Stream.mkString(Stream.decodeText(child.stdout));
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* Effect.fail(exitCode);
  }
  return new Map(
    stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        return [pid!, ppid!] as const;
      }),
  );
}, Effect.scoped);

export const watchDevRunnerParent = Effect.fn("dev-runner.watchParent")(function* () {
  if ((yield* HostProcess.Platform) === "win32") {
    return yield* Effect.never;
  }

  const parents = yield* readParents(undefined).pipe(
    Effect.catch(() =>
      Effect.logWarning("[dev-runner] parent watch unavailable; continuing without it.").pipe(
        Effect.andThen(Effect.never),
      ),
    ),
  );
  const expected = new Map<number, number>();
  for (let pid = process.pid; pid > 1;) {
    const parent = parents.get(pid);
    if (parent === undefined) {
      return yield* Effect.never;
    }
    expected.set(pid, parent);
    pid = parent;
  }

  while (true) {
    yield* Effect.sleep("1 second");
    const current = yield* readParents([...expected.keys()]).pipe(Effect.option);
    if (
      Option.isSome(current) &&
      [...expected].some(([pid, parent]) => current.value.get(pid) !== parent)
    ) {
      return;
    }
  }
});

export const devParentWatchEnabled = Effect.map(
  HostProcess.Environment,
  (env) => env.T3CODE_DEV_PARENT_WATCH !== "0",
);

const hangup = Effect.callback<never>((resume) => {
  const onHangup = () => resume(Effect.interrupt);
  process.on("SIGHUP", onHangup);
  return Effect.sync(() => {
    process.off("SIGHUP", onHangup);
  });
});

export const withDevRunnerLifecycle = Effect.fn("dev-runner.withLifecycle")(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
) {
  return yield* (yield* devParentWatchEnabled) && (yield* HostProcess.Platform) !== "win32"
    ? Effect.raceFirst(program, Effect.raceFirst(watchDevRunnerParent(), hangup))
    : program;
});
