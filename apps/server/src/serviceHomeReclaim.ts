// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const STOP_GRACE_MS = 15_000;
const START_SLACK_MS = 2_000;
const BASE_DIR_FLAG = "--base-dir";

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

const canonical = (target: string) => NodeFSP.realpath(target).catch(() => undefined);

function elapsedSeconds(value: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(value);
  if (match === null) return undefined;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

function servedBaseDir(args: ReadonlyArray<string>): string | undefined {
  const flags = args.flatMap((arg, index) => {
    if (arg === BASE_DIR_FLAG) return [{ value: args[index + 1], next: args[index + 2] }];
    if (arg.startsWith(`${BASE_DIR_FLAG}=`)) {
      return [{ value: arg.slice(BASE_DIR_FLAG.length + 1), next: args[index + 1] }];
    }
    return [];
  });
  const [flag] = flags;
  if (flag === undefined) return NodePath.join(NodeOS.homedir(), ".t3");
  if (flags.length > 1 || !flag.value || (flag.next !== undefined && !flag.next.startsWith("-"))) {
    return undefined;
  }
  return flag.value;
}

async function servesHome(pid: number, home: string, recordedAt: number): Promise<boolean> {
  const output = await execFile(
    "ps",
    ["-ww", "-o", "etime=", "-o", "command=", "-p", String(pid)],
    {
      timeout: 5_000,
      env: { ...process.env, LC_ALL: "C" },
    },
  ).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
  const [elapsed = "", program = "", command, ...args] = output.split(/\s+/);
  const seconds = elapsedSeconds(elapsed);
  if (seconds === undefined || command !== "serve" || NodePath.basename(program) !== "t3") {
    return false;
  }
  if (Date.now() - seconds * 1_000 > recordedAt + START_SLACK_MS) return false;
  const runtimeDir = await canonical(NodePath.dirname(program));
  const baseDir = servedBaseDir(args);
  return (
    runtimeDir?.startsWith(NodePath.join(home, "runtime", "versions") + NodePath.sep) === true &&
    baseDir !== undefined &&
    (await canonical(baseDir)) === home
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
  const home = await canonical(baseDir);
  if (home === undefined) return false;
  const launchDir = NodePath.join(baseDir, "ssh-launch");
  const entries = await NodeFSP.readdir(launchDir).catch(() => []);
  let stopped = false;
  for (const entry of entries) {
    const dir = NodePath.join(launchDir, entry);
    if ((await readRecord(dir, "managed")) !== "managed") continue;
    const pid = Number.parseInt(await readRecord(dir, "pid"), 10);
    const recordedAt = await NodeFSP.stat(NodePath.join(dir, "pid")).then(
      (stats) => stats.mtimeMs,
      () => undefined,
    );
    if (!Number.isInteger(pid) || pid <= 1 || recordedAt === undefined || !isAlive(pid)) continue;
    if (!(await servesHome(pid, home, recordedAt))) continue;
    if (!(await stopProcess(pid))) return false;
    process.stderr.write(
      `[service-launcher] Stopped the SSH-launched T3 Code server ${pid} that held this T3 home.\n`,
    );
    stopped = true;
  }
  return stopped;
}

async function homeOwnerRecorded(baseDir: string): Promise<boolean> {
  const runtime = await NodeFSP.readFile(
    NodePath.join(baseDir, "userdata", "server-runtime.json"),
    "utf8",
  ).catch(() => "");
  const pid = Number(/"pid"\s*:\s*(\d+)/.exec(runtime)?.[1]);
  return pid > 1 && isAlive(pid);
}

export async function freeOwnedHome(baseDir: string, acquire: boolean): Promise<boolean> {
  return (
    (await stopSshLaunchedServers(baseDir)) || (acquire && !(await homeOwnerRecorded(baseDir)))
  );
}
