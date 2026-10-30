// @effect-diagnostics nodeBuiltinImport:off -- The artifact watchdog must run even when a launcher cannot load.
// @effect-diagnostics globalTimers:off -- Startup qualification has a bounded watchdog window.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import { ChildTerminator } from "./serviceChildTerminator.ts";

export async function runLauncherWatchdog(executable: string): Promise<void> {
  const terminator = new ChildTerminator();
  let stopped = false;
  let child: NodeChildProcess.ChildProcess | undefined;
  const stop = () => {
    stopped = true;
    if (child !== undefined) void terminator.terminate(child);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    let restored = false;
    for (;;) {
      if (stopped) return;
      const current = NodeChildProcess.spawn(executable, ["__service-launcher"], {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
      child = current;
      let reachedLauncher = false;
      const timer = setTimeout(() => {
        if (!reachedLauncher) void terminator.terminate(current);
      }, 300_000);
      current.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          (("launcherStarted" in message && message.launcherStarted === 1) ||
            ("launcherChildSpawned" in message && message.launcherChildSpawned === 1) ||
            ("launcherReady" in message && message.launcherReady === 1))
        ) {
          reachedLauncher = true;
          clearTimeout(timer);
        }
      });
      const code = await new Promise<number>((resolve) => {
        current.once("exit", (code) => resolve(code ?? 1));
        current.once("error", () => resolve(1));
      });
      clearTimeout(timer);
      if (stopped || code === 0) {
        process.exitCode = 0;
        return;
      }
      if (!reachedLauncher && !restored) {
        const temporary = `${executable}.restore`;
        await NodeFSP.copyFile(`${executable}.lkg`, temporary);
        await NodeFSP.chmod(temporary, 0o755);
        await NodeFSP.rename(temporary, executable);
        restored = true;
      } else await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
