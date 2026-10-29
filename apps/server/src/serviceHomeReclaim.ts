// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const STOP_GRACE_MS = 15_000;

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const readRecord = (dir: string, name: string) =>
  NodeFSP.readFile(NodePath.join(dir, name), "utf8").then(
    (contents) => contents.trim(),
    () => "",
  );

async function servesHome(pid: number, baseDir: string): Promise<boolean> {
  const command = await execFile("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
    timeout: 5_000,
  }).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
  return (
    command.startsWith(NodePath.join(baseDir, "runtime", "versions") + NodePath.sep) &&
    /\sserve(\s|$)/.test(command)
  );
}

async function stopProcess(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isAlive(pid);
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

export async function stopSshLaunchedServers(baseDir: string): Promise<boolean> {
  const launchDir = NodePath.join(baseDir, "ssh-launch");
  const entries = await NodeFSP.readdir(launchDir).catch(() => []);
  let stopped = false;
  for (const entry of entries) {
    const dir = NodePath.join(launchDir, entry);
    if ((await readRecord(dir, "managed")) !== "managed") continue;
    const pid = Number.parseInt(await readRecord(dir, "pid"), 10);
    if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) continue;
    if (!(await servesHome(pid, baseDir))) continue;
    if (!(await stopProcess(pid))) return false;
    process.stderr.write(
      `[service-launcher] Stopped the SSH-launched T3 Code server ${pid} that held this T3 home.\n`,
    );
    stopped = true;
  }
  return stopped;
}
