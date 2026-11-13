// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import { SERVER_OWNER_LOCK_FILE } from "./cloud/serviceProtocol.ts";

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

interface Observation {
  readonly start: string;
  readonly argv: ReadonlyArray<string>;
}

async function observe(pid: number): Promise<Observation> {
  const start = await linuxStart(pid);
  const cmdline = await readText(`/proc/${pid}/cmdline`);
  const unchanged = start !== "" && (await linuxStart(pid)) === start;
  return { start, argv: unchanged ? cmdline.replace(/\0$/, "").split("\0") : [] };
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

async function linuxLegacyOwnerIsLive(baseDir: string, pid: number): Promise<boolean> {
  const start = await startOf(pid);
  if (start === "") return true;
  const observed = await observe(pid);
  if (observed.start !== start || observed.argv.length === 0) return true;
  const command = observed.argv.indexOf("serve");
  if (command < 0) {
    const [program = "", ...args] = observed.argv;
    const executable = await NodeFSP.readlink(`/proc/${pid}/exe`).catch(() => program);
    if ([program, executable].some((value) => /^t3(?:\.exe)?$/.test(NodePath.basename(value)))) {
      return true;
    }
    if (!/^node(?:js)?(?:\.exe)?$/.test(NodePath.basename(executable))) return false;
    for (const arg of args) {
      if (/^t3(?:\.[cm]?js|\.ts)?$/.test(NodePath.basename(arg))) return true;
      if (!/^bin\.(?:mjs|ts)$/.test(NodePath.basename(arg))) continue;
      const cwd = await NodeFSP.readlink(`/proc/${pid}/cwd`).catch(() => undefined);
      if (!NodePath.isAbsolute(arg) && cwd === undefined) return true;
      const manifest = await readText(
        NodePath.join(NodePath.dirname(NodePath.resolve(cwd ?? "/", arg)), "..", "package.json"),
      );
      if (manifest === "" || /"name"\s*:\s*"t3"/.test(manifest)) return true;
    }
    return false;
  }
  const args = observed.argv.slice(command + 1);
  const flags = args.filter((arg) => arg === BASE_DIR_FLAG || arg.startsWith(`${BASE_DIR_FLAG}=`));
  if (flags.length > 1) return true;
  const cwd = await NodeFSP.readlink(`/proc/${pid}/cwd`).catch(() => undefined);
  let served: string | undefined;
  if (flags.length === 1) {
    served = servedBaseDir(args);
  } else {
    const env = await NodeFSP.readFile(`/proc/${pid}/environ`, "utf8").catch(() => undefined);
    if (env === undefined) return true;
    const values = env.split("\0");
    served = values.find((value) => value.startsWith("T3CODE_HOME="))?.slice(12);
    if (!served) {
      const home = values.find((value) => value.startsWith("HOME="))?.slice(5);
      served = home ? NodePath.join(home, ".t3") : undefined;
    }
  }
  if (!served || (!NodePath.isAbsolute(served) && cwd === undefined)) return true;
  const home = await canonical(NodePath.resolve(cwd ?? "/", served));
  if (home === undefined || (await startOf(pid)) !== start) return true;
  return home === (await canonical(baseDir));
}

async function homeOwned(baseDir: string): Promise<boolean> {
  const stateDir = NodePath.join(baseDir, "userdata");
  const lockHeld = ownerLockHeld(stateDir);
  if (lockHeld === true) return true;
  const runtime = await readText(NodePath.join(stateDir, "server-runtime.json"));
  const pid = Number(/"pid"\s*:\s*(\d+)/.exec(runtime)?.[1]);
  const preLockOwner = !/"ownerId"\s*:/.test(runtime);
  if (pid <= 1 || !isAlive(pid) || (lockHeld === false && !preLockOwner)) return false;
  if (ON_LINUX && (await readText("/proc/sys/kernel/random/boot_id")).trim() !== "") {
    return linuxLegacyOwnerIsLive(baseDir, pid);
  }
  const recordedAt = Date.parse(/"startedAt"\s*:\s*"([^"]+)"/.exec(runtime)?.[1] ?? "");
  if (!Number.isFinite(recordedAt)) return true;
  const startedAt = Date.parse(`${await ps(pid, ["lstart"])} UTC`);
  return !Number.isFinite(startedAt) || startedAt <= recordedAt + 1_000;
}

export async function freeOwnedHome(baseDir: string) {
  return (await homeOwned(baseDir)) ? "owned" : "free";
}

export async function homeStarted(baseDir: string, pid: number): Promise<boolean> {
  const stateDir = NodePath.join(baseDir, "userdata");
  const runtime = await readText(NodePath.join(stateDir, "server-runtime.json"));
  return Number(/"pid"\s*:\s*(\d+)/.exec(runtime)?.[1]) === pid && ownerLockHeld(stateDir) === true;
}
