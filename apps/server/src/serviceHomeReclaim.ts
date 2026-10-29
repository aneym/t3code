// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import { isExactServiceVersion, SERVER_OWNER_LOCK_FILE } from "./cloud/serviceProtocol.ts";

const STOP_GRACE_MS = 15_000;
const BASE_DIR_FLAG = "--base-dir";
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
const ON_LINUX = process.platform === "linux";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const readText = (path: string) => NodeFSP.readFile(path, "utf8").catch(() => "");

const readRecord = (dir: string, name: string) =>
  readText(NodePath.join(dir, name)).then((contents) => contents.trim().replace(/\s+/g, " "));

const canonical = (target: string) => NodeFSP.realpath(target).catch(() => undefined);

const ps = (pid: number, fields: ReadonlyArray<string>) =>
  execFile("ps", ["-ww", ...fields.flatMap((field) => ["-o", `${field}=`]), "-p", String(pid)], {
    timeout: 5_000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
  }).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );

async function linuxStart(pid: number): Promise<string> {
  const [bootId, stat] = await Promise.all([
    readText("/proc/sys/kernel/random/boot_id"),
    readText(`/proc/${pid}/stat`),
  ]);
  const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
  return bootId.trim() !== "" && /^\d+$/.test(startTicks) ? `${bootId.trim()} ${startTicks}` : "";
}

const startOf = async (pid: number) =>
  ON_LINUX ? linuxStart(pid) : (await ps(pid, ["lstart"])).replace(/\s+/g, " ");

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

async function homeSpellings(baseDir: string, home: string): Promise<ReadonlyArray<string>> {
  const spellings: Array<string> = [];
  for (const spelling of new Set([baseDir, home, `${NodeOS.homedir()}/.t3`])) {
    if ((await canonical(spelling)) === home) spellings.push(spelling);
  }
  return spellings;
}

function serveArgvOf(command: string, homes: ReadonlyArray<string>): ReadonlyArray<string> {
  for (const spelling of homes) {
    const versions = `${spelling}/runtime/versions/`;
    if (!command.startsWith(versions)) continue;
    const program = `${versions}${command.slice(versions.length).split("/", 1)[0]}/t3`;
    if (command !== `${program} serve` && !command.startsWith(`${program} serve `)) continue;
    const rest = command.slice(`${program} serve `.length);
    const flag = /(?:^| )--base-dir[ =]/.exec(rest);
    const options = (flag === null ? rest : rest.slice(0, flag.index)).split(" ").filter(Boolean);
    const baseDir = flag === null ? [] : [BASE_DIR_FLAG, rest.slice(flag.index + flag[0].length)];
    return [program, "serve", ...options, ...baseDir];
  }
  return [];
}

interface Observation {
  readonly start: string;
  readonly argv: ReadonlyArray<string>;
}

async function observe(pid: number, homes: ReadonlyArray<string>): Promise<Observation> {
  if (ON_LINUX) {
    const start = await linuxStart(pid);
    const cmdline = await readText(`/proc/${pid}/cmdline`);
    const unchanged = start !== "" && (await linuxStart(pid)) === start;
    return { start, argv: unchanged ? cmdline.replace(/\0$/, "").split("\0") : [] };
  }
  const output = await ps(pid, ["lstart", "command"]);
  const match = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/s.exec(output);
  return {
    start: (match?.[1] ?? "").replace(/\s+/g, " "),
    argv: serveArgvOf(match?.[2] ?? "", homes),
  };
}

async function runsFromHome(program: string, home: string): Promise<boolean> {
  const versionDir = NodePath.dirname(program);
  const runtimeDir = NodePath.dirname(NodePath.dirname(versionDir));
  return (
    NodePath.isAbsolute(program) &&
    NodePath.normalize(program) === program &&
    NodePath.basename(program) === "t3" &&
    isExactServiceVersion(NodePath.basename(versionDir)) &&
    NodePath.dirname(versionDir) === NodePath.join(runtimeDir, "versions") &&
    NodePath.basename(runtimeDir) === "runtime" &&
    (await canonical(NodePath.dirname(runtimeDir))) === home
  );
}

async function servesHome(argv: ReadonlyArray<string>, home: string): Promise<boolean> {
  const [program = "", command, ...args] = argv;
  const baseDir = servedBaseDir(args);
  return (
    command === "serve" &&
    (await runsFromHome(program, home)) &&
    baseDir !== undefined &&
    (await canonical(baseDir)) === home
  );
}

async function terminateIfSame(pid: number, start: string): Promise<boolean> {
  if ((await startOf(pid)) !== start) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

async function exitsWithinGrace(pid: number, start: string): Promise<boolean> {
  const deadline = performance.now() + STOP_GRACE_MS;
  while ((await startOf(pid)) === start) {
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

export async function stopSshLaunchedServers(baseDir: string): Promise<boolean> {
  const home = await canonical(baseDir);
  if (home === undefined) return false;
  const homes = ON_LINUX ? [] : await homeSpellings(baseDir, home);
  const launchDir = NodePath.join(baseDir, "ssh-launch");
  const entries = await NodeFSP.readdir(launchDir).catch(() => []);
  let stopped = false;
  for (const entry of entries) {
    const dir = NodePath.join(launchDir, entry);
    if ((await readRecord(dir, "managed")) !== "managed") continue;
    const recordedPid = await readRecord(dir, "pid");
    const pid = /^\d+$/.test(recordedPid) ? Number(recordedPid) : 0;
    const start = await readRecord(dir, "start");
    if (!Number.isSafeInteger(pid) || pid <= 1 || start === "" || !isAlive(pid)) continue;
    const observed = await observe(pid, homes);
    if (observed.start !== start || !(await servesHome(observed.argv, home))) continue;
    if (!(await terminateIfSame(pid, start))) continue;
    if (!(await exitsWithinGrace(pid, start))) return false;
    process.stderr.write(
      `[service-launcher] Stopped the SSH-launched T3 Code server ${pid} that held this T3 home.\n`,
    );
    stopped = true;
  }
  return stopped;
}

function ownerLockHeld(stateDir: string): boolean | undefined {
  let lock: NodeSqlite.DatabaseSync | undefined;
  try {
    lock = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, SERVER_OWNER_LOCK_FILE));
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK;");
    return false;
  } catch (cause) {
    return cause instanceof Error && "errcode" in cause && cause.errcode === 5 ? true : undefined;
  } finally {
    lock?.close();
  }
}

async function homeOwned(baseDir: string): Promise<boolean> {
  const stateDir = NodePath.join(baseDir, "userdata");
  const lockHeld = ownerLockHeld(stateDir);
  if (lockHeld === true) return true;
  const runtime = await readText(NodePath.join(stateDir, "server-runtime.json"));
  const pid = Number(/"pid"\s*:\s*(\d+)/.exec(runtime)?.[1]);
  const preLockOwner = !/"ownerId"\s*:/.test(runtime);
  return pid > 1 && isAlive(pid) && (lockHeld === undefined || preLockOwner);
}

export async function freeOwnedHome(baseDir: string, acquire: boolean): Promise<boolean> {
  return (await stopSshLaunchedServers(baseDir)) || (acquire && !(await homeOwned(baseDir)));
}
