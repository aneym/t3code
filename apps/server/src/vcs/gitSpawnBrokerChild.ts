// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The broker child is a plain Node IPC process outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";

type ParentMessage =
  | {
      readonly t: "spawn";
      readonly id: number;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd?: string;
      readonly env: NodeJS.ProcessEnv;
    }
  | { readonly t: "in"; readonly id: number; readonly d: Uint8Array }
  | { readonly t: "end"; readonly id: number }
  | {
      readonly t: "kill";
      readonly id: number;
      readonly signal: NodeJS.Signals;
      readonly forceAfter?: number;
    };

export function runGitSpawnBroker(): void {
  const kids = new Map<number, NodeChildProcess.ChildProcessWithoutNullStreams>();
  const send = (message: object) => {
    if (process.connected) process.send?.(message);
  };
  const signalGroup = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  };
  process.on("message", (message: ParentMessage) => {
    if (message.t === "spawn") {
      let child: NodeChildProcess.ChildProcessWithoutNullStreams;
      try {
        child = NodeChildProcess.spawn(message.command, message.args, {
          cwd: message.cwd,
          env: message.env,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        const cause = error as NodeJS.ErrnoException;
        send({ id: message.id, t: "error", code: cause.code, message: String(cause.message) });
        return;
      }
      kids.set(message.id, child);
      child.on("error", (error: NodeJS.ErrnoException) =>
        send({ id: message.id, t: "error", code: error.code, message: String(error.message) }),
      );
      child.on("spawn", () => send({ id: message.id, t: "spawned", pid: child.pid }));
      child.stdin.on("error", () => {});
      child.stdout.on("data", (d: Uint8Array) => send({ id: message.id, t: "out", fd: 1, d }));
      child.stderr.on("data", (d: Uint8Array) => send({ id: message.id, t: "out", fd: 2, d }));
      child.on("close", (code, signal) => {
        kids.delete(message.id);
        send({ id: message.id, t: "exit", code, signal });
      });
      return;
    }
    const child = kids.get(message.id);
    if (child === undefined) return;
    if (message.t === "in") child.stdin.write(message.d);
    else if (message.t === "end") child.stdin.end();
    else {
      signalGroup(child, message.signal);
      if (message.forceAfter !== undefined)
        setTimeout(() => {
          if (kids.has(message.id)) signalGroup(child, "SIGKILL");
        }, message.forceAfter).unref();
    }
  });
  process.on("disconnect", () => {
    for (const child of kids.values()) signalGroup(child, "SIGKILL");
    process.exit(0);
  });
  send({ t: "ready" });
}
