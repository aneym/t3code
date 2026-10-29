// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

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

async function serveExecutables(baseDir: string, home: string): Promise<ReadonlyArray<string>> {
  const versions = await NodeFSP.readdir(NodePath.join(home, "runtime", "versions")).catch(
    () => [],
  );
  const homes: Array<string> = [];
  for (const spelling of new Set([baseDir, home, `${NodeOS.homedir()}/.t3`])) {
    if ((await canonical(spelling)) === home) homes.push(spelling);
  }
  return homes.flatMap((spelling) =>
    versions.map((version) => `${spelling}/runtime/versions/${version}/t3`),
  );
}

function serveArgvOf(command: string, executables: ReadonlyArray<string>): ReadonlyArray<string> {
  const program = executables.find(
    (executable) => command === `${executable} serve` || command.startsWith(`${executable} serve `),
  );
  if (program === undefined) return [];
  const rest = command.slice(`${program} serve `.length);
  const flag = /(?:^| )--base-dir[ =]/.exec(rest);
  const options = (flag === null ? rest : rest.slice(0, flag.index)).split(" ").filter(Boolean);
  const baseDir = flag === null ? [] : [BASE_DIR_FLAG, rest.slice(flag.index + flag[0].length)];
  return [program, "serve", ...options, ...baseDir];
}

interface Observation {
  readonly start: string;
  readonly argv: ReadonlyArray<string>;
}

async function observe(pid: number, executables: ReadonlyArray<string>): Promise<Observation> {
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
    argv: serveArgvOf(match?.[2] ?? "", executables),
  };
}

async function servesHome(argv: ReadonlyArray<string>, home: string): Promise<boolean> {
  const [program = "", command, ...args] = argv;
  if (command !== "serve" || NodePath.basename(program) !== "t3") return false;
  const runtimeDir = await canonical(NodePath.dirname(program));
  const baseDir = servedBaseDir(args);
  return (
    runtimeDir?.startsWith(NodePath.join(home, "runtime", "versions") + NodePath.sep) === true &&
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
  const executables = await serveExecutables(baseDir, home);
  const launchDir = NodePath.join(baseDir, "ssh-launch");
  const entries = await NodeFSP.readdir(launchDir).catch(() => []);
  let stopped = false;
  for (const entry of entries) {
    const dir = NodePath.join(launchDir, entry);
    if ((await readRecord(dir, "managed")) !== "managed") continue;
    const pid = Number.parseInt(await readRecord(dir, "pid"), 10);
    const start = await readRecord(dir, "start");
    if (!Number.isInteger(pid) || pid <= 1 || start === "") continue;
    const observed = await observe(pid, executables);
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
