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
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stopped) return;
      const current = NodeChildProcess.spawn(executable, ["__service-launcher"], {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
      child = current;
      let qualified = false;
      const timer = setTimeout(() => {
        if (!qualified) void terminator.terminate(current);
      }, 30_000);
      current.on("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "launcherReady" in message &&
          message.launcherReady === 1
        ) {
          qualified = true;
          clearTimeout(timer);
        }
      });
      const code = await new Promise<number>((resolve) => {
        current.once("exit", (code) => resolve(code ?? 1));
        current.once("error", () => resolve(1));
      });
      clearTimeout(timer);
      if (stopped || qualified || attempt === 1) {
        process.exitCode = stopped ? 0 : code;
        return;
      }
      const temporary = `${executable}.restore`;
      await NodeFSP.copyFile(`${executable}.lkg`, temporary);
      await NodeFSP.chmod(temporary, 0o755);
      await NodeFSP.rename(temporary, executable);
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
