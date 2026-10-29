// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { stopSshLaunchedServers } from "./serviceHomeReclaim.ts";

interface Sandbox {
  readonly home: string;
  readonly otherHome: string;
  readonly serve: (baseDir: string) => Promise<NodeChildProcess.ChildProcess>;
  readonly record: (child: NodeChildProcess.ChildProcess) => Promise<string>;
}

const next = (child: NodeChildProcess.ChildProcess, event: "spawn" | "exit") =>
  new Promise<Array<unknown>>((resolve) =>
    child.once(event, (...args: Array<unknown>) => resolve(args)),
  );

async function withSandbox(test: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-home-reclaim-"));
  const children: Array<NodeChildProcess.ChildProcess> = [];
  try {
    const home = NodePath.join(root, "home");
    const otherHome = NodePath.join(root, "other-home");
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
      record: async (child) => {
        const dir = NodePath.join(home, "ssh-launch", `record-${String(child.pid)}`);
        await NodeFSP.mkdir(dir, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(dir, "pid"), `${String(child.pid)}\n`);
        await NodeFSP.writeFile(NodePath.join(dir, "managed"), "managed\n");
        return NodePath.join(dir, "pid");
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

it("stops a server the SSH launcher recorded for this T3 home", () =>
  withSandbox(async ({ home, serve, record }) => {
    const stray = await serve(home);
    await record(stray);
    const exited = next(stray, "exit");

    assert.isTrue(await stopSshLaunchedServers(home));
    assert.deepEqual(await exited, [null, "SIGTERM"]);
  }));

it("leaves a recorded PID alone when it now serves another T3 home", () =>
  withSandbox(async ({ home, otherHome, serve, record }) => {
    const other = await serve(otherHome);
    await record(other);

    assert.isFalse(await stopSshLaunchedServers(home));
    assert.isTrue(isRunning(other));
  }));

it("leaves a process alone when it started after the SSH launcher's record", () =>
  withSandbox(async ({ home, serve, record }) => {
    const later = await serve(home);
    const pidFile = await record(later);
    const recordedAtSeconds = 1_577_836_800;
    await NodeFSP.utimes(pidFile, recordedAtSeconds, recordedAtSeconds);

    assert.isFalse(await stopSshLaunchedServers(home));
    assert.isTrue(isRunning(later));
  }));
