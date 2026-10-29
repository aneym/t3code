// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { assert, describe, it } from "@effect/vitest";
import { RECORD_START_SCRIPT } from "@t3tools/ssh/remoteHomeServerScript";
import { vi } from "vite-plus/test";

import { SERVER_OWNER_LOCK_FILE, SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import { stopSshLaunchedServers } from "./serviceHomeReclaim.ts";
import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";

interface Sandbox {
  readonly home: string;
  readonly otherHome: string;
  readonly versionDir: string;
  readonly serve: (baseDir: string) => Promise<NodeChildProcess.ChildProcess>;
  readonly record: (
    child: NodeChildProcess.ChildProcess,
    start: string | null,
    pid?: string,
  ) => Promise<void>;
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const launcherStart = async (pid: number | undefined) =>
  (await execFile("/bin/sh", ["-euc", `${RECORD_START_SCRIPT}\nrecord_start "$1"`, "sh", `${pid}`]))
    .stdout;

const next = (child: NodeChildProcess.ChildProcess, event: "spawn" | "exit") =>
  new Promise<Array<unknown>>((resolve) =>
    child.once(event, (...args: Array<unknown>) => resolve(args)),
  );

async function withSandbox(user: string, test: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-home-reclaim-"));
  const children: Array<NodeChildProcess.ChildProcess> = [];
  try {
    const home = NodePath.join(root, user, ".t3");
    const otherHome = NodePath.join(root, user, "other-home");
    const versionDir = NodePath.join(home, "runtime", "versions", "1.0.0");
    const scriptDir = NodePath.join(root, "script");
    await NodeFSP.mkdir(versionDir, { recursive: true });
    await NodeFSP.mkdir(otherHome, { recursive: true });
    await NodeFSP.mkdir(scriptDir, { recursive: true });
    await NodeFSP.symlink(process.execPath, NodePath.join(versionDir, "t3"));
    await NodeFSP.writeFile(NodePath.join(scriptDir, "serve"), "setInterval(() => {}, 1 << 30);\n");
    await test({
      home,
      otherHome,
      versionDir,
      serve: async (baseDir) => {
        const child = NodeChildProcess.spawn(
          NodePath.join(versionDir, "t3"),
          ["serve", "--host", "127.0.0.1", "--base-dir", baseDir],
          { cwd: scriptDir, stdio: "ignore" },
        );
        children.push(child);
        await next(child, "spawn");
        return child;
      },
      record: async (child, start, pid = `${String(child.pid)}\n`) => {
        const dir = NodePath.join(home, "ssh-launch", `record-${String(child.pid)}`);
        await NodeFSP.mkdir(dir, { recursive: true });
        if (start !== null) await NodeFSP.writeFile(NodePath.join(dir, "start"), start);
        await NodeFSP.writeFile(NodePath.join(dir, "pid"), pid);
        await NodeFSP.writeFile(NodePath.join(dir, "managed"), "managed\n");
      },
    });
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = next(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

const isRunning = (child: NodeChildProcess.ChildProcess) =>
  child.exitCode === null && child.signalCode === null;

describe.each(["alex", "Alex Smith", "t3 serve Alex"])("T3 home under %s", (user) => {
  it("stops a server the SSH launcher recorded for this T3 home", () =>
    withSandbox(user, async ({ home, serve, record }) => {
      const stray = await serve(home);
      await record(stray, await launcherStart(stray.pid));
      const exited = next(stray, "exit");

      assert.isTrue(await stopSshLaunchedServers(home));
      assert.deepEqual(await exited, [null, "SIGTERM"]);
    }));

  it("stops a recorded server whose runtime version was pruned while it ran", () =>
    withSandbox(user, async ({ home, versionDir, serve, record }) => {
      const stray = await serve(home);
      await record(stray, await launcherStart(stray.pid));
      await NodeFSP.rm(versionDir, { recursive: true });
      const exited = next(stray, "exit");

      assert.isTrue(await stopSshLaunchedServers(home));
      assert.deepEqual(await exited, [null, "SIGTERM"]);
    }));

  it("leaves a recorded PID alone when it now serves another T3 home", () =>
    withSandbox(user, async ({ home, otherHome, serve, record }) => {
      const other = await serve(otherHome);
      await record(other, await launcherStart(other.pid));

      assert.isFalse(await stopSshLaunchedServers(home));
      assert.isTrue(isRunning(other));
    }));

  it("leaves a recorded PID alone when a different process now holds it", () =>
    withSandbox(user, async ({ home, serve, record }) => {
      const successor = await serve(home);
      await record(successor, await launcherStart(1));

      assert.isFalse(await stopSshLaunchedServers(home));
      assert.isTrue(isRunning(successor));
    }));

  it("leaves a server alone when its record has no start identity", () =>
    withSandbox(user, async ({ home, serve, record }) => {
      const older = await serve(home);
      await record(older, null);

      assert.isFalse(await stopSshLaunchedServers(home));
      assert.isTrue(isRunning(older));
    }));

  it("leaves a server alone when its pid record is not exactly one decimal pid", () =>
    withSandbox(user, async ({ home, serve, record }) => {
      const stray = await serve(home);
      const start = await launcherStart(stray.pid);
      await record(stray, start, `${String(stray.pid)}garbage\n`);
      assert.isFalse(await stopSshLaunchedServers(home));
      await record(stray, start, `${String(stray.pid)}\n${String(process.pid)}\n`);
      assert.isFalse(await stopSshLaunchedServers(home));
      assert.isTrue(isRunning(stray));
    }));
});

it("takes the T3 home once a legacy SSH-launched server holding it dies, even after its PID is reused", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-home-recovery-"));
  const home = NodePath.join(root, ".t3");
  const lockPath = NodePath.join(home, "userdata", SERVER_OWNER_LOCK_FILE);
  const runtimePath = NodePath.join(home, "userdata", "server-runtime.json");
  let successor: NodeChildProcess.ChildProcess | undefined;
  const versionDir = NodePath.join(home, "runtime", "versions", "1.0.0");
  const statePath = NodePath.join(home, "runtime", "service-state.json");
  const served = Promise.withResolvers<void>();
  const listener = NodeNet.createServer(() => served.resolve());
  await NodeFSP.mkdir(NodePath.dirname(lockPath), { recursive: true });
  await NodeFSP.mkdir(versionDir, { recursive: true });
  const owner = NodeChildProcess.spawn(
    process.execPath,
    [
      "-e",
      `const lock = new (require("node:sqlite").DatabaseSync)(process.argv[1]);
lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ version: "1.0.0", pid: process.pid, port: 1, origin: "http://127.0.0.1:1", startedAt: new Date().toISOString(), ownerId: "legacy" }));
console.log("held");
process.stdin.on("end", () => process.exit()).resume();`,
      lockPath,
      runtimePath,
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const held = new Promise<void>((resolve, reject) => {
    owner.stdout.once("data", () => resolve());
    owner.once("error", reject);
    owner.once("exit", (code, signal) =>
      reject(new Error(`Owner exited before readiness: ${String(code ?? signal)}`)),
    );
  });
  const refused = Promise.withResolvers<void>();
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    if (String(chunk).includes("owns this T3 home")) refused.resolve();
    return true;
  });
  try {
    await held;
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await NodeFSP.writeFile(
      NodePath.join(versionDir, "t3"),
      `#!${process.execPath}
const lock = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(lockPath)});
try { lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"); } catch { process.exit(78); }
require("node:net").connect(${port}, "127.0.0.1");
setInterval(() => {}, 1 << 30);
`,
      { mode: 0o755 },
    );
    await NodeFSP.writeFile(NodePath.join(versionDir, ".install-complete"), "1.0.0\n");
    await writeServiceState(statePath, {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
    });
    const legacyRecord = NodePath.join(home, "ssh-launch", "legacy");
    await NodeFSP.mkdir(legacyRecord, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(legacyRecord, "pid"), `${String(owner.pid)}\n`);
    await NodeFSP.writeFile(NodePath.join(legacyRecord, "managed"), "managed\n");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const launcher = new Launcher(home, await readServiceState(statePath));
    const running = launcher.run();
    await refused.promise;
    await vi.advanceTimersByTimeAsync(30 * 5_000);
    assert.isTrue(isRunning(owner));

    successor = NodeChildProcess.spawn(
      process.execPath,
      ["-e", 'process.stdin.on("end", () => process.exit()).resume();'],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    await next(successor, "spawn");
    const runtime = await NodeFSP.readFile(runtimePath, "utf8");
    assert.include(runtime, `"pid":${String(owner.pid)}`);
    await NodeFSP.writeFile(
      runtimePath,
      runtime.replace(`"pid":${String(owner.pid)}`, `"pid":${String(successor.pid)}`),
    );
    const ownerExited = next(owner, "exit");
    owner.kill("SIGKILL");
    await ownerExited;
    await vi.advanceTimersByTimeAsync(5_000);
    await served.promise;

    await launcher.stop("SIGTERM");
    await running;
  } finally {
    vi.useRealTimers();
    stderr.mockRestore();
    for (const child of [owner, successor]) {
      if (child !== undefined && isRunning(child)) child.kill("SIGKILL");
    }
    listener.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
