// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// The launcher must survive unloadable server versions; use Node built-ins without Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  PendingServiceUpdate,
  ServiceLauncherChildMessage,
  ServiceLauncherContext,
  ServiceLauncherParentMessage,
  ServiceState,
  ServiceUpdateRecord,
} from "./cloud/serviceProtocol.ts";
import { ServiceRestartGuards } from "./serviceRestartGuards.ts";
import {
  databaseBackupBlocker,
  databaseBackupDir,
  databaseRestorePending,
  backupDatabaseOnce,
  restoreDatabaseBackup,
  discardDatabaseBackup,
  type BackupSpaceProbe,
} from "./serviceLauncherDatabase.ts";
export type { BackupSpaceProbe } from "./serviceLauncherDatabase.ts";
export { databaseBackupBlocker } from "./serviceLauncherDatabase.ts";
import { ServiceLauncherIngress, probeServiceChild } from "./serviceLauncherIngress.ts";
import {
  readLauncherIngressConfig,
  candidateCanHotSwap,
  type LauncherIngressConfig,
} from "./serviceLauncherConfig.ts";
import { reserveServiceOwnership } from "./serviceLauncherOwnership.ts";
import { readServiceEnvironment } from "./serviceEnvironment.ts";
import { isCliForkVersion } from "@t3tools/shared/cliRelease";

import {
  compareExactServiceVersions,
  decodeServiceLauncherChildMessage,
  isExactServiceVersion,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";

const HANDOFF_DELAY_MS = 2_000;
/**
 * Migrations count toward it and can scale with the database: tens of GB on a cold page cache
 * take minutes. A missed window rolls back the database, so the next attempt pays the same cost.
 */
const PREPARED_TIMEOUT_MS = 30 * 60_000;

type TerminalStatus = "committed" | "rolled-back" | "failed";
type ChildRole = "active" | "trial";

interface ManagedChild {
  readonly version: string;
  role: ChildRole;
  stateDirOwned: boolean;
  capable: boolean;
  readonly instanceId: string;
  readonly process: NodeChildProcess.ChildProcess;
}

import {
  runtimePaths,
  runtimeSpawnArguments,
  runtimeExists,
  readServiceState,
  writeServiceState,
} from "./serviceLauncherState.ts";
export { readServiceState, writeServiceState } from "./serviceLauncherState.ts";

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
  #warming: ManagedChild | null = null;
  #swap: { phase: "warm" | "drain" | "relinquish"; willMigrate: boolean } | undefined;
  readonly #ingress: ServiceLauncherIngress;
  readonly #ingressConfig: LauncherIngressConfig | undefined;
  #timer: NodeJS.Timeout | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #stopRequested = false;
  #stopping = false;
  #done = false;
  readonly #guards = new ServiceRestartGuards();
  readonly #completion = Promise.withResolvers<void>();
  readonly #backupSpaceProbe: Partial<BackupSpaceProbe> | undefined;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;

  constructor(
    baseDir: string,
    state: ServiceState,
    options: {
      readonly backupSpaceProbe?: Partial<BackupSpaceProbe>;
      readonly environment?: Readonly<NodeJS.ProcessEnv>;
      readonly ingress?: LauncherIngressConfig;
    } = {},
  ) {
    this.#baseDir = baseDir;
    this.#ingressConfig = options.ingress;
    this.#ingress = new ServiceLauncherIngress(options.ingress);
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
      this.#enqueue(async () => {
        await this.#recover();
        process.send?.({ launcherReady: 1 });
      });
      await this.#completion.promise;
    } finally {
      await this.#ingress.close();
      if (this.#warming !== null) await this.#guards.terminator.terminate(this.#warming.process);
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

  async #fatal(error: Error): Promise<void> {
    if (this.#done) return;
    this.#guards.failure = error;
    this.#guards.startStopDeadline(() => {
      this.#done = true;
      this.#stopping = true;
      return this.#child?.process;
    });
    this.#stopping = true;
    this.#clearTimer();
    if (this.#warming !== null) await this.#guards.terminator.terminate(this.#warming.process);
    this.#warming = null;
    const child = this.#child?.process;
    this.#child = null;
    if (child !== undefined) await this.#guards.terminator.terminate(child);
    this.#done = true;
    this.#completion.reject(error);
  }

  async stop(signal: NodeJS.Signals): Promise<void> {
    if (!this.#stopRequested && !this.#done) {
      this.#stopRequested = true;
      this.#guards.startStopDeadline(() => {
        this.#done = true;
        this.#stopping = true;
        return this.#child?.process;
      });
      const marker = this.#guards.terminator.holdSignalsUntil(writeStopMarker(this.#baseDir));
      this.#clearTimer();
      // Let in-progress updates start replacements first; replacements observe the marker and own pre-activation tunnel cleanup.
      this.#enqueue(async () => {
        this.#stopping = true;
        this.#clearTimer();
        if (this.#warming !== null) await this.#guards.terminator.terminate(this.#warming.process);
        this.#warming = null;
        const child = this.#child?.process;
        this.#child = null;
        if (child !== undefined) await this.#guards.terminator.terminate(child, signal);
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
    // Clear old stop markers to preserve future tunnels; clear restart-pending only for the awaited version to avoid CLI races.
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
    const instanceId = NodeCrypto.randomUUID();
    let reservation: Awaited<ReturnType<typeof reserveServiceOwnership>> | undefined;
    try {
      if (this.#ingressConfig !== undefined)
        reservation = await reserveServiceOwnership(this.#baseDir, instanceId);
      await backupDatabaseOnce(this.#baseDir, pending);
    } catch {
      reservation?.release();
      await this.#returnToPrevious(pending, "failed", "db-backup-failed");
      return;
    }
    reservation?.release();
    try {
      await this.#startChild(pending.targetVersion, "trial", pending, false, instanceId);
    } catch {
      await this.#returnToPrevious(pending, "failed", "candidate-start-failed");
    }
  }

  async #startChild(
    version: string,
    role: ChildRole,
    update?: ServiceUpdateRecord,
    warm = false,
    instanceId = NodeCrypto.randomUUID(),
  ): Promise<void> {
    if (this.#stopping) return;
    if (!(await runtimeExists(this.#baseDir, version))) {
      throw new Error(`Selected t3@${version} runtime is missing or incomplete.`);
    }
    if (this.#stopping) return;
    const paths = runtimePaths(this.#baseDir, version);
    const context: ServiceLauncherContext = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: version,
      ...(this.#ingressConfig === undefined
        ? {}
        : {
            hotSwap: {
              instanceId,
              warm,
              protocol: 1,
              publicHost: this.#ingressConfig.host,
              publicPort: this.#ingressConfig.port,
              holdBudgetMs: this.#ingressConfig.holdBudgetMs,
            },
          }),
      ...(update === undefined ? {} : { update }),
    };
    const spawnArguments = runtimeSpawnArguments(paths);
    const child = NodeChildProcess.spawn(spawnArguments.command, spawnArguments.args, {
      env: {
        ...this.#environment,
        ...(this.#ingressConfig === undefined
          ? {}
          : {
              T3CODE_PORT: String(this.#ingressConfig.port),
              T3CODE_HOST: this.#ingressConfig.host,
            }),
        [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context),
      },
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
      await this.#guards.terminator.terminate(child);
      return;
    }

    const managed: ManagedChild = {
      version,
      role,
      stateDirOwned: false,
      capable: false,
      instanceId,
      process: child,
    };
    if (warm) this.#warming = managed;
    else this.#child = managed;
    child.on("message", (value) => {
      const message = decodeServiceLauncherChildMessage(value);
      if (message?.type === "socket-accepted") this.#ingress.ack(child, message.transferId);
      else if (message !== undefined) this.#enqueue(() => this.#handleMessage(managed, message));
    });
    child.once("exit", (code, signal) =>
      this.#enqueue(() => this.#handleExit(managed, code, signal)),
    );

    this.#guards.watch(this.#baseDir, child, () => this.#child === managed);
    if (role === "trial") {
      this.#timer = setTimeout(
        () => this.#enqueue(() => this.#handlePreparedTimeout(managed)),
        PREPARED_TIMEOUT_MS,
      );
    }
  }

  async #handleMessage(child: ManagedChild, message: ServiceLauncherChildMessage): Promise<void> {
    if ((this.#child !== child && this.#warming !== child) || this.#stopping) return;
    if (message.type === "ingress-ready") {
      child.capable = true;
      if (
        this.#ingressConfig === undefined ||
        message.host !== this.#ingressConfig.host ||
        message.port !== this.#ingressConfig.port
      )
        throw new Error("Child endpoint differs from launcher configuration.");
      await this.#ingress.bind(message.host, message.port);
      if (child !== this.#warming) {
        const reservation = await reserveServiceOwnership(this.#baseDir, child.instanceId);
        reservation.release();
      }
      await sendMessage(child.process, { type: "ingress-bound" });
      return;
    }
    if (message.type === "listening") {
      if (child !== this.#child || child.role !== "active") return;
      await probeServiceChild(message.port, child.instanceId);
      this.#ingress.route(child.process);
      return;
    }
    if (message.type === "warm") {
      const pending = this.#state.update;
      if (
        child !== this.#warming ||
        this.#swap?.phase !== "warm" ||
        pending?.status !== "pending" ||
        pending.id !== message.updateId
      )
        return;
      if (message.willMigrate) {
        this.#warming = null;
        this.#swap = undefined;
        await this.#guards.terminator.terminate(child.process);
        const old = this.#child;
        this.#child = null;
        this.#ingress.route();
        if (old !== null) await this.#guards.terminator.terminate(old.process);
        await this.#startTrial(pending);
        return;
      }
      this.#swap = { phase: "drain", willMigrate: false };
      const active = this.#child;
      if (active === null) throw new Error("Warm trial has no active child.");
      await sendMessage(active.process, {
        type: "drain",
        updateId: pending.id,
        drainTimeoutMs: this.#ingressConfig?.drainTimeoutMs ?? 0,
      });
      return;
    }
    if (message.type === "drain-failed") {
      if (child === this.#child) await this.#dropWarm("drain-failed");
      return;
    }
    if (message.type === "drained") {
      const pending = this.#state.update;
      if (
        child !== this.#child ||
        this.#swap?.phase !== "drain" ||
        pending?.status !== "pending" ||
        pending.id !== message.updateId
      )
        return;
      this.#swap.phase = "relinquish";
      this.#ingress.route();
      await sendMessage(child.process, { type: "relinquish", updateId: pending.id });
      return;
    }
    if (message.type === "validated") {
      const pending = this.#state.update;
      if (
        child !== this.#child ||
        child.role !== "trial" ||
        pending?.status !== "pending" ||
        pending.id !== message.updateId
      )
        return;
      try {
        await probeServiceChild(message.port, child.instanceId, pending.id);
      } catch {
        await this.#returnToPrevious(pending, "rolled-back", "identity-probe-failed", child);
        return;
      }
      try {
        await this.#handlePrepared(child, message.updateId);
      } catch {
        await this.#returnToPrevious(pending, "rolled-back", "commit-failed", child);
      }
      return;
    }
    if (message.type === "socket-accepted") return;
    if (message.type === "state-dir-owned") {
      child.stateDirOwned = true;
      return;
    }
    if (message.type === "request-update") {
      await this.#handleUpdateRequest(child, message);
      return;
    }
    if (message.type === "prepared") await this.#handlePrepared(child, message.updateId);
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
    // Failed checks must refuse updates rather than stop the server with unknown backup capacity.
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
    this.#guards.resetRetries();
    await sendMessage(child.process, { type: "update-accepted", updateId: pending.id });
    this.#timer = setTimeout(() => this.#enqueue(() => this.#beginTrial(child)), HANDOFF_DELAY_MS);
  }

  async #beginTrial(child: ManagedChild): Promise<void> {
    const pending = this.#state.update;
    if (this.#child !== child || child.role !== "active" || pending?.status !== "pending") {
      return;
    }
    this.#timer = undefined;
    if (
      child.capable &&
      this.#ingressConfig !== undefined &&
      (await candidateCanHotSwap(this.#baseDir, pending.targetVersion, this.#ingressConfig))
    ) {
      this.#swap = { phase: "warm", willMigrate: false };
      try {
        await this.#startChild(pending.targetVersion, "trial", pending, true);
      } catch {
        await this.#dropWarm("candidate-start-failed");
      }
      return;
    }
    this.#child = null;
    await this.#guards.terminator.terminate(child.process);
    await this.#ingress.close();
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
    if (child.capable) this.#ingress.route(child.process);
    this.#guards.resetRetries();
    await discardDatabaseBackup(this.#baseDir, committed.id).catch(() => undefined);
    await sendMessage(child.process, { type: "committed", updateId: committed.id });
  }

  async #dropWarm(reason: string): Promise<void> {
    const pending = this.#state.update;
    const warm = this.#warming;
    const phase = this.#swap?.phase;
    this.#warming = null;
    this.#swap = undefined;
    this.#clearTimer();
    if (warm !== null) await this.#guards.terminator.terminate(warm.process);
    if (pending?.status !== "pending") return;
    if (phase === "relinquish" || this.#child === null) {
      const old = this.#child;
      this.#child = null;
      if (old !== null) await this.#guards.terminator.terminate(old.process);
      await this.#returnToPrevious(pending, "rolled-back", reason);
      return;
    }
    if (this.#child !== null && phase === "drain")
      await sendMessage(this.#child.process, { type: "abort-drain", updateId: pending.id });
    const next: ServiceState = {
      ...this.#state,
      update: terminalUpdate({ pending, status: "rolled-back", reason }),
    };
    await writeServiceState(this.#statePath, next);
    this.#state = next;
  }

  async #handlePreparedTimeout(child: ManagedChild): Promise<void> {
    if (this.#warming === child) {
      await this.#dropWarm("warm-timeout");
      return;
    }
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
    if (this.#stopping) return;
    if (this.#warming === child) {
      if (!child.capable && code === 78 && this.#state.update?.status === "pending") {
        const pending = this.#state.update;
        this.#warming = null;
        this.#swap = undefined;
        this.#clearTimer();
        const old = this.#child;
        this.#child = null;
        if (old !== null) await this.#guards.terminator.terminate(old.process);
        await this.#ingress.close();
        await this.#startTrial(pending);
      } else await this.#dropWarm(`warm-exited:${String(code ?? signal ?? "unknown")}`);
      return;
    }
    if (this.#child !== child) return;
    this.#child = null;
    if (
      this.#warming !== null &&
      this.#swap !== undefined &&
      this.#state.update?.status === "pending"
    ) {
      const pending = this.#state.update;
      const trial = this.#warming;
      if (this.#swap.phase !== "relinquish") {
        await this.#dropWarm("active-exited-during-warm");
        return;
      }
      const migrate = this.#swap.willMigrate;
      this.#warming = null;
      this.#swap = undefined;
      this.#ingress.route();
      try {
        const reservation = await reserveServiceOwnership(this.#baseDir, trial.instanceId);
        try {
          if (migrate) await backupDatabaseOnce(this.#baseDir, pending);
        } finally {
          reservation.release();
        }
        this.#child = trial;
        await sendMessage(trial.process, { type: "acquire", updateId: pending.id });
      } catch {
        await this.#returnToPrevious(pending, "rolled-back", "handoff-failed", trial);
      }
      return;
    }
    this.#ingress.route();
    const pending = this.#state.update;
    const retry = await this.#guards.retryAfterExit(
      code,
      child.stateDirOwned,
      pending?.status === "pending" ? databaseBackupDir(this.#baseDir, pending.id) : undefined,
      this.#baseDir,
    );
    if (retry === "exhausted") {
      this.#clearTimer();
      if (pending?.status !== "pending") throw new Error("Unclassified exit 78 exhausted retries.");
      await this.#returnToPrevious(pending, "failed", "unclassified-exit:78");
      return;
    }
    if (retry !== undefined) {
      this.#clearTimer();
      this.#timer = setTimeout(() => this.#enqueue(() => this.#restartOwned(child)), retry);
      return;
    }
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
    if (pending?.status === "pending") {
      await this.#startTrial(pending);
      return;
    }
    if (
      pending?.status === "committed" &&
      this.#ingressConfig !== undefined &&
      (await candidateCanHotSwap(this.#baseDir, pending.targetVersion, this.#ingressConfig))
    ) {
      await this.#returnToPrevious(
        {
          ...pending,
          status: "pending",
          dbPath: NodePath.join(this.#baseDir, "userdata", "statev2.sqlite"),
        },
        "rolled-back",
        "activation-exited",
      );
      return;
    }
    throw new Error(`Active child exited unexpectedly (${String(code ?? signal ?? "unknown")}).`);
  }

  async #restartOwned(child: ManagedChild): Promise<void> {
    this.#timer = undefined;
    if (!(await this.#guards.homeAvailable(this.#baseDir))) {
      this.#timer = setTimeout(() => this.#enqueue(() => this.#restartOwned(child)), 5_000);
      return;
    }
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
    this.#ingress.route();
    if (child !== undefined) {
      this.#child = null;
      await this.#guards.terminator.terminate(child.process);
    }
    if (this.#state.update?.status !== "committed")
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
    if (
      this.#ingressConfig !== undefined &&
      !(await candidateCanHotSwap(this.#baseDir, next.activeVersion, this.#ingressConfig))
    )
      await this.#ingress.close();
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
  const ingress = await readLauncherIngressConfig(baseDir);
  await new Launcher(baseDir, state, {
    environment,
    ...(ingress === undefined ? {} : { ingress }),
  }).run();
}
