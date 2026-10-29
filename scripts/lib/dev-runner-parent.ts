import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const readParents = Effect.fn("dev-runner.readParents")(function* (pids?: ReadonlyArray<number>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdout = yield* spawner.string(
    ChildProcess.make(
      "ps",
      pids ? ["-o", "pid=,ppid=", "-p", pids.join(",")] : ["-axo", "pid=,ppid="],
      {
        stdin: "ignore",
      },
    ),
  );
  return new Map(
    stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        return [pid!, ppid!] as const;
      }),
  );
});

export const watchDevRunnerParent = Effect.fn("dev-runner.watchParent")(function* () {
  if ((yield* HostProcess.Platform) === "win32") {
    return yield* Effect.never;
  }

  const parents = yield* readParents();
  const expected = new Map<number, number>();
  for (let pid = process.pid; pid > 1;) {
    const parent = parents.get(pid);
    if (parent === undefined) {
      return;
    }
    expected.set(pid, parent);
    pid = parent;
  }

  while (true) {
    yield* Effect.sleep("1 second");
    const current = yield* readParents([...expected.keys()]);
    if ([...expected].some(([pid, parent]) => current.get(pid) !== parent)) {
      return;
    }
  }
});
