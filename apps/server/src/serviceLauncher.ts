// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type {
  PendingServiceUpdate,
  ServiceLauncherChildMessage,
  ServiceLauncherContext,
  ServiceLauncherParentMessage,
  ServiceState,
  ServiceUpdateRecord,
} from "./cloud/serviceProtocol.ts";
import { ChildTerminator } from "./serviceChildTerminator.ts";
import { copyDatabaseFile, killCopyHelpers, runCp } from "./serviceDatabaseCopy.ts";
import { isCliForkVersion } from "@t3tools/shared/cliRelease";

import {
  compareExactServiceVersions,
  decodeServiceLauncherChildMessage,
  isExactServiceVersion,
  parseServiceState,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";

const HANDOFF_DELAY_MS = 2_000;
const PREPARED_TIMEOUT_MS = 30 * 60_000;
const OWNED_RETRY_MAX_MS = 30_000;
const STATE_DIR_OWNED_EXIT_CODE = 78;

type TerminalStatus = "committed" | "rolled-back" | "failed";
type ChildRole = "active" | "trial";

interface ManagedChild {
  readonly version: string;
  role: ChildRole;
  stateDirOwned: boolean;
  readonly process: NodeChildProcess.ChildProcess;
}

const runtimePaths = (baseDir: string, version: string) => {
  const versionDir = NodePath.join(baseDir, "runtime", "versions", version);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const executableName = process.platform === "win32" ? "t3.exe" : "t3";
  return {
    versionDir,
    entryPath: NodePath.join(versionDir, executableName),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
};

const runtimeSpawnArguments = (paths: ReturnType<typeof runtimePaths>) => ({
  command: paths.entryPath,
  args: ["serve"],
});

const DB_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;
const RESTORE_MARKER = ".restore-pending";
const UNSAFE_RESTORE_MARKER = ".restore-unsafe";

const databaseBackupDir = (baseDir: string, updateId: string) =>
  NodePath.join(baseDir, "runtime", "db-backup", updateId);

const databaseBackupFile = (backupDir: string, suffix: (typeof DB_FILE_SUFFIXES)[number]) =>
  NodePath.join(backupDir, suffix === "" ? "database" : `database${suffix}`);

async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

const MANAGED_SERVICE_ENV_NAMES = new Set([
  "PATH",
  "T3CODE_HOME",
  "T3_BOOT_SERVICE_UNIT",
  SERVICE_LAUNCHER_CONTEXT_ENV,
]);

export async function readServiceEnvironment(
  baseDir: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const environment = { ...inherited };
  let contents: string;
  try {
    contents = await NodeFSP.readFile(NodePath.join(baseDir, SERVICE_ENV_FILE), "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return environment;
    throw cause;
  }
  for (const [name, value] of Object.entries(NodeUtil.parseEnv(contents))) {
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !MANAGED_SERVICE_ENV_NAMES.has(name.toUpperCase())
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await NodeFSP.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFSP.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    await handle.close();
  }
}

const GIB = 1024 ** 3;
const CLONED_BACKUP_MIN_HEADROOM_BYTES = GIB;
const CLONED_BACKUP_HEADROOM_FRACTION = 0.1;

async function statDatabaseFiles(dbPath: string): Promise<ReadonlyArray<NodeFS.Stats>> {
  const stats: Array<NodeFS.Stats> = [];
  for (const suffix of DB_FILE_SUFFIXES) {
    const stat = await NodeFSP.stat(`${dbPath}${suffix}`).catch((cause: unknown) => {
      if (suffix !== "" && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (stat !== undefined) stats.push(stat);
  }
  return stats;
}

async function backupCanClone(dbPath: string, backupRoot: string): Promise<boolean> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
  const platform = process.platform;
  if (platform === "darwin") {
    const [backupDirectory, backupFs, systemFs] = await Promise.all([
      NodeFSP.stat(backupRoot),
      NodeFSP.statfs(backupRoot),
      NodeFSP.statfs("/"),
    ]);
    if (backupFs.type !== systemFs.type) return false;
    return (await statDatabaseFiles(dbPath)).every(
      (source) => source.dev === backupDirectory.dev && source.nlink === 1,
    );
  }
  if (platform !== "linux") return false;
  const probe = NodePath.join(backupRoot, `.clone-probe-${NodeCrypto.randomUUID()}`);
  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      if (!(await runCp(["--reflink=always", source, `${probe}${suffix}`]))) return false;
    }
    return true;
  } finally {
    for (const suffix of DB_FILE_SUFFIXES) {
      await NodeFSP.rm(`${probe}${suffix}`, { force: true }).catch(() => undefined);
    }
  }
}

export interface BackupSpaceProbe {
  readonly readFreeBytes: (directory: string) => Promise<number>;
  readonly canClone: (dbPath: string, backupRoot: string) => Promise<boolean>;
}

const filesystemBackupSpaceProbe: BackupSpaceProbe = {
  readFreeBytes: async (directory) => {
    const stats = await NodeFSP.statfs(directory);
    return stats.bavail * stats.bsize;
  },
  canClone: backupCanClone,
};

export async function databaseBackupBlocker(
  baseDir: string,
  dbPath: string,
  probe: Partial<BackupSpaceProbe> = {},
): Promise<string | undefined> {
  const { readFreeBytes, canClone } = { ...filesystemBackupSpaceProbe, ...probe };
  const backupRoot = NodePath.join(baseDir, "runtime", "db-backup");
  await NodeFSP.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const [files, free] = await Promise.all([statDatabaseFiles(dbPath), readFreeBytes(backupRoot)]);
  const size = files.reduce((total, file) => total + file.size, 0);
  const fullCopyBytes = size * 1.05;
  if (free >= fullCopyBytes) return undefined;
  const clonedBytes = Math.max(
    CLONED_BACKUP_MIN_HEADROOM_BYTES,
    size * CLONED_BACKUP_HEADROOM_FRACTION,
  );
  const needed = (await canClone(dbPath, backupRoot)) ? clonedBytes : fullCopyBytes;
  if (free >= needed) return undefined;
  const gb = (bytes: number) => (bytes / GIB).toFixed(1);
  return `Not enough free disk space to back up the database before updating: ${gb(needed)} GB needed, ${gb(free)} GB free. Free up disk space and try again. The server was not stopped.`;
}

async function backupDatabaseOnce(baseDir: string, pending: PendingServiceUpdate): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (await pathExists(backupDir)) return;

  const stagingDir = `${backupDir}.staging`;
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    for (const suffix of DB_FILE_SUFFIXES) {
      const source = `${pending.dbPath}${suffix}`;
      if (suffix !== "" && !(await pathExists(source))) continue;
      const destination = databaseBackupFile(stagingDir, suffix);
      await copyDatabaseFile(source, destination);
      await syncFile(destination);
    }
    await NodeFSP.rename(stagingDir, backupDir);
    await syncDirectory(NodePath.dirname(backupDir));
  } catch (cause) {
    await NodeFSP.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

const restoreMarkerPath = (baseDir: string, updateId: string) =>
  NodePath.join(databaseBackupDir(baseDir, updateId), RESTORE_MARKER);

const databaseRestorePending = (baseDir: string, pending: PendingServiceUpdate) =>
  pathExists(restoreMarkerPath(baseDir, pending.id));

async function markDatabaseBackup(backupDir: string, marker: string): Promise<void> {
  const markerPath = NodePath.join(backupDir, marker);
  if (!(await pathExists(markerPath))) {
    const handle = await NodeFSP.open(markerPath, "wx", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(backupDir);
  }
}

async function restoreTarget(path: string): Promise<string> {
  let current = path;
  for (let hops = 0; hops < 40; hops++) {
    try {
      return await NodeFSP.realpath(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    const link = await NodeFSP.readlink(current).catch((cause: unknown) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL") return undefined;
      throw cause;
    });
    if (link === undefined) return current;
    current = NodePath.isAbsolute(link)
      ? link
      : `${await NodeFSP.realpath(NodePath.dirname(current))}${NodePath.sep}${link}`;
  }
  throw new Error(`Too many symbolic links resolving ${path}.`);
}

async function restoreDatabaseBackup(
  baseDir: string,
  pending: PendingServiceUpdate,
): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, pending.id);
  if (!(await pathExists(backupDir))) return;
  if (await pathExists(NodePath.join(backupDir, UNSAFE_RESTORE_MARKER))) {
    process.stderr.write(
      `[service-launcher] Automatic restore refused; backup retained at ${backupDir}.\n`,
    );
    return;
  }

  await markDatabaseBackup(backupDir, RESTORE_MARKER);
  const directories = new Set([NodePath.dirname(pending.dbPath)]);
  for (const suffix of DB_FILE_SUFFIXES) {
    const livePath = `${pending.dbPath}${suffix}`;
    const source = databaseBackupFile(backupDir, suffix);
    if (await pathExists(source)) {
      const target = await restoreTarget(livePath);
      await copyDatabaseFile(source, target);
      await syncFile(target);
      directories.add(NodePath.dirname(target));
    } else {
      await NodeFSP.rm(livePath, { force: true });
    }
  }
  for (const directory of directories) await syncDirectory(directory);
}

async function discardDatabaseBackup(baseDir: string, updateId: string): Promise<void> {
  const backupDir = databaseBackupDir(baseDir, updateId);
  if (!(await pathExists(backupDir))) return;
  if (await pathExists(NodePath.join(backupDir, UNSAFE_RESTORE_MARKER))) return;
  await NodeFSP.rm(backupDir, { recursive: true, force: true });
  await syncDirectory(NodePath.dirname(backupDir));
}

export async function readServiceState(filePath: string): Promise<ServiceState> {
  const contents = await NodeFSP.readFile(filePath, "utf8");
  const state = parseServiceState(contents);
  if (state === undefined) throw new Error("Service state is invalid or unsupported.");
  return state;
}

export async function writeServiceState(filePath: string, state: ServiceState): Promise<void> {
  const directory = NodePath.dirname(filePath);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = NodePath.join(
    directory,
    `.${NodePath.basename(filePath)}.${process.pid}.${NodeCrypto.randomUUID()}`,
  );
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await NodeFSP.rename(tempPath, filePath);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function runtimeExists(baseDir: string, version: string): Promise<boolean> {
  const paths = runtimePaths(baseDir, version);
  try {
    const [entry, sentinel] = await Promise.all([
      NodeFSP.stat(paths.entryPath),
      NodeFSP.readFile(paths.sentinelPath, "utf8"),
    ]);
    return entry.isFile() && sentinel.trim() === version;
  } catch {
    return false;
  }
}

function terminalUpdate<S extends TerminalStatus>(input: {
  readonly pending: PendingServiceUpdate;
  readonly status: S;
  readonly reason?: string;
}): Exclude<ServiceUpdateRecord, PendingServiceUpdate> & { readonly status: S } {
  return {
    id: input.pending.id,
    fromVersion: input.pending.fromVersion,
    targetVersion: input.pending.targetVersion,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

function sendMessage(
  child: NodeChildProcess.ChildProcess,
  message: ServiceLauncherParentMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected || child.send === undefined) {
      reject(new Error("service child IPC is disconnected."));
      return;
    }
    child.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
}

const stopMarkerPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_STOP_MARKER_FILE);
const writeStopMarker = (baseDir: string) =>
  NodeFSP.writeFile(stopMarkerPath(baseDir), "", { mode: 0o600 }).catch(() => undefined);
const restartPendingPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_RESTART_PENDING_FILE);

export class Launcher {
  readonly #baseDir: string;
  readonly #statePath: string;
  #state: ServiceState;
  #child: ManagedChild | null = null;
  #timer: NodeJS.Timeout | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #stopping = false;
  #done = false;
  #failure: Error | undefined;
  #ownedRetries = 0;
  #unclassifiedRetries = 0;
  readonly #terminator = new ChildTerminator();
  readonly #completion = Promise.withResolvers<void>();
  readonly #backupSpaceProbe: Partial<BackupSpaceProbe> | undefined;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;

  constructor(
    baseDir: string,
    state: ServiceState,
    options: {
      readonly backupSpaceProbe?: Partial<BackupSpaceProbe>;
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
    } = {},
  ) {
    this.#baseDir = baseDir;
    this.#backupSpaceProbe = options.backupSpaceProbe;
    this.#environment = { ...(options.environment ?? process.env) };
    this.#statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
    this.#state = state;
  }

  async run(): Promise<void> {
    const onSigterm = () => void this.stop("SIGTERM");
    const onSigint = () => void this.stop("SIGINT");
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    try {
      this.#enqueue(() => this.#recover());
      await this.#completion.promise;
    } finally {
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
    }
  }

  #enqueue(transition: () => Promise<void>): void {
    this.#transitions = this.#transitions
      .then(transition, transition)
      .catch((cause: unknown) =>
        this.#fatal(cause instanceof Error ? cause : new Error(String(cause))),
      );
  }

  #startStopDeadline(): void {
    this.#terminator.startStopDeadline(() => {
      this.#done = true;
      this.#stopping = true;
      this.#child?.process.kill("SIGKILL");
      killCopyHelpers();
      if (this.#failure !== undefined) {
        process.stderr.write(`[service-launcher] ${this.#failure.message}\n`);
      }
      process.stderr.write(
        "[service-launcher] Stop deadline passed; exiting without the server.\n",
      );
      process.removeAllListeners("SIGTERM");
      process.kill(process.pid, "SIGTERM");
    });
  }

  async #fatal(error: Error): Promise<void> {
    if (this.#done) return;
    this.#failure = error;
    this.#startStopDeadline();
    this.#stopping = true;
    this.#clearTimer();
    const child = this.#child?.process;
    this.#child = null;
    if (child !== undefined) await this.#terminator.terminate(child);
    this.#done = true;
    this.#completion.reject(error);
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    if (!this.#stopRequested && !this.#done) {
      this.#stopRequested = true;
      this.#startStopDeadline();
      const marker = this.#terminator.holdSignalsUntil(writeStopMarker(this.#baseDir));
      this.#clearTimer();
      this.#enqueue(async () => {
        this.#stopping = true;
        this.#clearTimer();
        const child = this.#child?.process;
        this.#child = null;
        if (child !== undefined) await this.#terminator.terminate(child, signal);
        await marker;
        this.#done = true;
        this.#completion.resolve();
      });
    }
    await this.#completion.promise.catch(() => undefined);
  }

  #clearTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #recover(): Promise<void> {
    await NodeFSP.rm(stopMarkerPath(this.#baseDir), { force: true }).catch(() => undefined);
    const restartPending = restartPendingPath(this.#baseDir);
    const awaitedVersion = await NodeFSP.readFile(restartPending, "utf8").catch(() => undefined);
    if (awaitedVersion?.trim() === this.#state.activeVersion) {
      await NodeFSP.rm(restartPending, { force: true }).catch(() => undefined);
    }
    const update = this.#state.update;
    if (update?.status !== "pending") {
      if (update !== undefined) {
        await discardDatabaseBackup(this.#baseDir, update.id).catch(() => undefined);
      }
      await this.#startChild(this.#state.activeVersion, "active", update);
      return;
    }
    if (await databaseRestorePending(this.#baseDir, update)) {
      await this.#returnToPrevious(update, "failed", "rollback-interrupted");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, update.targetVersion))) {
      await this.#returnToPrevious(update, "failed", "target-runtime-missing");
      return;
    }
    await this.#startTrial(update);
  }

  async #startTrial(pending: PendingServiceUpdate): Promise<void> {
    try {
      await backupDatabaseOnce(this.#baseDir, pending);
    } catch {
      await this.#returnToPrevious(pending, "failed", "db-backup-failed");
      return;
    }
    try {
      await this.#startChild(pending.targetVersion, "trial", pending);
    } catch {
      await this.#returnToPrevious(pending, "failed", "candidate-start-failed");
    }
  }

  async #startChild(version: string, role: ChildRole, update?: ServiceUpdateRecord): Promise<void> {
    if (this.#stopping) return;
    if (!(await runtimeExists(this.#baseDir, version))) {
      throw new Error(`Selected t3@${version} runtime is missing or incomplete.`);
    }
    if (this.#stopping) return;
    const paths = runtimePaths(this.#baseDir, version);
    const context: ServiceLauncherContext = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: version,
      ...(update === undefined ? {} : { update }),
    };
    const spawnArguments = runtimeSpawnArguments(paths);
    const child = NodeChildProcess.spawn(spawnArguments.command, spawnArguments.args, {
      env: { ...this.#environment, [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context) },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.removeListener("error", onError);
        child.on("error", (error) => this.#enqueue(() => Promise.reject(error)));
        resolve();
      });
    });
    if (this.#stopping) {
      await this.#terminator.terminate(child);
      return;
    }

    const managed: ManagedChild = {
      version,
      role,
      stateDirOwned: false,
      process: child,
    };
    this.#child = managed;
    child.on("message", (value) => {
      const message = decodeServiceLauncherChildMessage(value);
      if (message !== undefined) this.#enqueue(() => this.#handleMessage(managed, message));
    });
    child.once("exit", (code, signal) =>
      this.#enqueue(() => this.#handleExit(managed, code, signal)),
    );

    if (role === "trial") {
      this.#timer = setTimeout(
        () => this.#enqueue(() => this.#handlePreparedTimeout(managed)),
        PREPARED_TIMEOUT_MS,
      );
    }
  }

  async #handleMessage(child: ManagedChild, message: ServiceLauncherChildMessage): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    if (message.type === "state-dir-owned") {
      child.stateDirOwned = true;
      return;
    }
    if (message.type === "request-update") {
      await this.#handleUpdateRequest(child, message);
      return;
    }
    await this.#handlePrepared(child, message.updateId);
  }

  async #handleUpdateRequest(
    child: ManagedChild,
    message: Extract<ServiceLauncherChildMessage, { readonly type: "request-update" }>,
  ): Promise<void> {
    const reject = (reason: string) =>
      sendMessage(child.process, { type: "update-rejected", reason });
    if (child.role !== "active") {
      await reject("Only the active server can request an update.");
      return;
    }
    if (child.version !== this.#state.activeVersion) {
      await reject("The requesting server is not the selected active version.");
      return;
    }
    if (this.#state.update?.status === "pending") {
      await reject("Another server update is already pending.");
      return;
    }
    if (!isExactServiceVersion(message.targetVersion)) {
      await reject("The requested target is not an exact version.");
      return;
    }
    if (isCliForkVersion(child.version) !== isCliForkVersion(message.targetVersion)) {
      await reject("The requested target is from a different distribution.");
      return;
    }
    const comparison = compareExactServiceVersions(message.targetVersion, child.version);
    if (comparison === 0 || (comparison < 0 && message.allowDowngrade !== true)) {
      await reject("Remote updates must select a newer server version.");
      return;
    }
    if (!NodePath.isAbsolute(message.dbPath)) {
      await reject("The requested database path is not absolute.");
      return;
    }
    if (!(await runtimeExists(this.#baseDir, message.targetVersion))) {
      await reject("The requested target runtime is missing or incomplete.");
      return;
    }
    const backupBlocker = await databaseBackupBlocker(
      this.#baseDir,
      message.dbPath,
      this.#backupSpaceProbe,
    ).catch(
      (error: unknown) =>
        `Could not check that the database backup fits before updating: ${error instanceof Error ? error.message : String(error)}. The server was not stopped.`,
    );
    if (!child.process.connected) return;
    if (backupBlocker !== undefined) {
      await reject(backupBlocker);
      return;
    }

    const pending: PendingServiceUpdate = {
      id: NodeCrypto.randomUUID(),
      fromVersion: child.version,
      targetVersion: message.targetVersion,
      dbPath: message.dbPath,
      status: "pending",
    };
    const next: ServiceState = { ...this.#state, update: pending };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    this.#ownedRetries = this.#unclassifiedRetries = 0;
    await sendMessage(child.process, { type: "update-accepted", updateId: pending.id });
    this.#timer = setTimeout(() => this.#enqueue(() => this.#beginTrial(child)), HANDOFF_DELAY_MS);
  }

  async #beginTrial(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "active" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    this.#child = null;
    await this.#terminator.terminate(child.process);
    await this.#startTrial(pending);
  }

  async #handlePrepared(child: ManagedChild, updateId: string): Promise<void> {
    const pending = this.#state.update;
    if (
      child.role !== "trial" ||
      pending?.status !== "pending" ||
      pending.id !== updateId ||
      pending.targetVersion !== child.version
    ) {
      if (child.role === "trial" && pending?.status === "pending") {
        await this.#returnToPrevious(pending, "rolled-back", "invalid-prepared", child);
        return;
      }
      throw new Error("Trial child reported prepared for an unexpected update.");
    }
    this.#clearTimer();
    const committed = terminalUpdate({ pending, status: "committed" });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.targetVersion,
      update: committed,
    };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    child.role = "active";
    this.#ownedRetries = this.#unclassifiedRetries = 0;
    await discardDatabaseBackup(this.#baseDir, committed.id).catch(() => undefined);
    await sendMessage(child.process, { type: "committed", updateId: committed.id });
  }

  async #handlePreparedTimeout(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "trial" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    await this.#returnToPrevious(pending, "rolled-back", "prepared-timeout", child);
  }

  async #handleExit(
    child: ManagedChild,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.#child !== child || this.#stopping) return;
    this.#child = null;
    if (code === STATE_DIR_OWNED_EXIT_CODE) {
      const pending = this.#state.update;
      if (pending?.status === "pending") {
        const backup = databaseBackupDir(this.#baseDir, pending.id);
        if (await pathExists(backup)) await markDatabaseBackup(backup, UNSAFE_RESTORE_MARKER);
      }
      if (!child.stateDirOwned && this.#unclassifiedRetries++ >= 5) {
        this.#clearTimer();
        this.#ownedRetries = 0;
        this.#unclassifiedRetries = 0;
        if (pending?.status !== "pending")
          throw new Error("Unclassified exit 78 exhausted retries.");
        await this.#returnToPrevious(pending, "failed", "unclassified-exit:78");
        return;
      }
      if (child.stateDirOwned) this.#unclassifiedRetries = 0;
      this.#retryWhileStateDirOwned(child);
      return;
    }
    this.#ownedRetries = 0;
    this.#unclassifiedRetries = 0;
    if (child.role === "trial") {
      this.#clearTimer();
      const pending = this.#state.update;
      if (pending?.status !== "pending") {
        throw new Error("Trial child exited without matching pending state.");
      }
      await this.#returnToPrevious(
        pending,
        "rolled-back",
        `candidate-exited:${String(code ?? signal ?? "unknown")}`,
      );
      return;
    }

    this.#clearTimer();
    const pending = this.#state.update;
    if (pending?.status === "pending") {
      await this.#startTrial(pending);
      return;
    }
    throw new Error(`Active child exited unexpectedly (${String(code ?? signal ?? "unknown")}).`);
  }

  #retryWhileStateDirOwned(child: ManagedChild): void {
    this.#clearTimer();
    if (this.#ownedRetries === 0) {
      process.stderr.write(
        child.stateDirOwned
          ? "[service-launcher] Another T3 Code server owns this T3 home. Retrying until it stops.\n"
          : "[service-launcher] Unclassified exit 78; retrying up to 5 times.\n",
      );
    }
    const delay = Math.min(1_000 * 2 ** this.#ownedRetries++, OWNED_RETRY_MAX_MS);
    this.#timer = setTimeout(() => this.#enqueue(() => this.#restartOwned(child)), delay);
  }

  async #restartOwned(child: ManagedChild): Promise<void> {
    this.#timer = undefined;
    const pending = this.#state.update;
    if (child.role === "trial" && pending?.status === "pending") {
      await this.#startTrial(pending);
      return;
    }
    await this.#startChild(this.#state.activeVersion, "active", this.#state.update);
  }

  async #returnToPrevious(
    pending: PendingServiceUpdate,
    status: "rolled-back" | "failed",
    reason: string,
    child?: ManagedChild,
  ): Promise<void> {
    if (child !== undefined) {
      this.#child = null;
      await this.#terminator.terminate(child.process);
    }
    await restoreDatabaseBackup(this.#baseDir, pending);
    const outcome = terminalUpdate({ pending, status, reason });
    const next: ServiceState = {
      ...this.#state,
      activeVersion: pending.fromVersion,
      update: outcome,
    };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
    await discardDatabaseBackup(this.#baseDir, pending.id).catch(() => undefined);
    await this.#startChild(next.activeVersion, "active", outcome);
  }
}

export async function main(): Promise<void> {
  const baseDir = process.env.T3CODE_HOME?.trim();
  if (baseDir === undefined || baseDir === "") {
    throw new Error("T3CODE_HOME is required by the T3 Code service launcher.");
  }
  const environment = await readServiceEnvironment(baseDir);
  const statePath = NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE);
  const state = await readServiceState(statePath);
  await new Launcher(baseDir, state, { environment }).run();
}
