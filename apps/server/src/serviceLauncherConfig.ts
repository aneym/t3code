// @effect-diagnostics nodeBuiltinImport:off -- Qualification is read before any server is spawned.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

export const HOT_SWAP_PROTOCOL = 1;

export interface LauncherIngressConfig {
  readonly protocol: typeof HOT_SWAP_PROTOCOL;
  readonly manager: "launchd" | "systemd";
  readonly host: string;
  readonly port: number;
  readonly holdBudgetMs: number;
  readonly measuredStartupMs: number;
  readonly maxQueued: number;
  readonly maxTransfers: number;
  readonly drainTimeoutMs: number;
}

const succeeds = (command: string, args: string[], expected?: string) =>
  new Promise<boolean>((resolve) => {
    const child = NodeChildProcess.spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 4096) output += chunk.toString();
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) =>
      resolve(code === 0 && (expected === undefined || output.trim() === expected)),
    );
  });

export async function readLauncherIngressConfig(
  baseDir: string,
  qualification = true,
): Promise<LauncherIngressConfig | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(
      await NodeFSP.readFile(NodePath.join(baseDir, "runtime", "launcher-config.json"), "utf8"),
    );
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    v.protocol !== HOT_SWAP_PROTOCOL ||
    (v.manager !== "launchd" && v.manager !== "systemd") ||
    typeof v.host !== "string" ||
    typeof v.port !== "number" ||
    !Number.isInteger(v.port) ||
    v.port < 1 ||
    v.port > 65535 ||
    typeof v.holdBudgetMs !== "number" ||
    v.holdBudgetMs <= 0 ||
    v.holdBudgetMs > 300_000 ||
    typeof v.measuredStartupMs !== "number" ||
    v.measuredStartupMs <= 0 ||
    v.measuredStartupMs >= v.holdBudgetMs ||
    typeof v.maxQueued !== "number" ||
    !Number.isInteger(v.maxQueued) ||
    v.maxQueued < 1 ||
    v.maxQueued > 8192 ||
    typeof v.maxTransfers !== "number" ||
    !Number.isInteger(v.maxTransfers) ||
    v.maxTransfers < 1 ||
    v.maxTransfers > 256 ||
    typeof v.drainTimeoutMs !== "number" ||
    v.drainTimeoutMs < 0 ||
    v.drainTimeoutMs > 300_000
  )
    return undefined;
  if (qualification) {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone supervisor qualification has no Effect context.
    if (process.platform === "darwin" && v.manager === "launchd") {
      if (!(await succeeds("launchctl", ["print", `gui/${process.getuid?.()}`]))) return undefined;
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone supervisor qualification has no Effect context.
    } else if (process.platform === "linux" && v.manager === "systemd") {
      if (
        !(await succeeds("systemctl", ["--user", "show-environment"])) ||
        !(await succeeds(
          "loginctl",
          ["show-user", String(process.getuid?.()), "--property=Linger", "--value"],
          "yes",
        ))
      )
        return undefined;
    } else return undefined;
  }
  return v as unknown as LauncherIngressConfig;
}

export async function candidateCanHotSwap(
  baseDir: string,
  version: string,
  config: LauncherIngressConfig,
): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(baseDir, "runtime", "versions", version, "hot-swap.json"),
        "utf8",
      ),
    );
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
      v.protocol === HOT_SWAP_PROTOCOL &&
      v.maintenance === false &&
      v.migration === false &&
      typeof v.measuredStartupMs === "number" &&
      v.measuredStartupMs > 0 &&
      v.measuredStartupMs <= config.measuredStartupMs
    );
  } catch {
    return false;
  }
}
