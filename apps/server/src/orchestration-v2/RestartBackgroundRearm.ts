// @effect-diagnostics nodeBuiltinImport:off -- lsof and Claude's task output files live on the host.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ProviderThreadId,
  OrchestrationV2ProviderThread,
  OrchestrationV2RestartCancelledBackgroundWork,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import type {
  ProjectionRuntimeRecoveryState,
  ProjectionStoreV2Error,
  ProjectionStoreV2Shape,
} from "./ProjectionStore.ts";

type Work = OrchestrationV2RestartCancelledBackgroundWork;

const MAX_COMMAND_LENGTH = 1000;
const SETTLED = new Set(["completed", "failed"]);
const BASH_OUTPUT_PATH = /Output is being written to: (\S+\.output)\.?(?!\S)/;

interface Launch {
  readonly command: string | undefined;
  readonly outputPath: string | undefined;
}

function launchedTaskId(item: OrchestrationV2TurnItem): string | undefined {
  if (item.type === "command_execution") {
    return /running in background with ID: ([\w-]+)/.exec(item.output ?? "")?.[1];
  }
  if (item.type !== "dynamic_tool" || item.toolName !== "Monitor") return undefined;
  const output = item.output;
  if (output === null || typeof output !== "object") return undefined;
  const taskId =
    Reflect.get(output, "taskId") ??
    Reflect.get(Reflect.get(output, "structuredContent") ?? {}, "taskId");
  return typeof taskId === "string" ? taskId : undefined;
}

function launchCommand(item: OrchestrationV2TurnItem): string | undefined {
  if (item.type === "command_execution") return item.input ?? undefined;
  if (item.type !== "dynamic_tool" || item.input === null || typeof item.input !== "object") {
    return undefined;
  }
  const command = Reflect.get(item.input, "command");
  return typeof command === "string" ? command : undefined;
}

function launches(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  const byTaskId = new Map<string, Launch>();
  const byItemId = new Map<string, Launch>();
  const taskDirs = new Set<string>();
  const unstartedMonitors: Array<Launch> = [];
  for (const item of items) {
    const outputPath =
      item.type === "command_execution" ? BASH_OUTPUT_PATH.exec(item.output ?? "")?.[1] : undefined;
    if (outputPath !== undefined) taskDirs.add(NodePath.dirname(outputPath));
    const launch = { command: launchCommand(item), outputPath };
    byItemId.set(item.id, launch);
    const taskId = launchedTaskId(item);
    if (taskId !== undefined) byTaskId.set(taskId, launch);
    else if (
      item.type === "dynamic_tool" &&
      item.toolName === "Monitor" &&
      !SETTLED.has(item.status)
    )
      unstartedMonitors.push(launch);
  }
  return { byTaskId, byItemId, taskDirs, unstartedMonitors };
}

const exists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.access(path).then(
      () => true,
      () => false,
    ),
  );

const claudeTaskRoot = () => {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const base = process.env.CLAUDE_CODE_TMPDIR?.trim() || "/tmp";
  return NodePath.join(base, `claude-${uid}`);
};

const findOutputPath = Effect.fnUntraced(function* (
  taskId: string,
  taskDirs: ReadonlySet<string>,
  sessionId: string | undefined,
) {
  for (const dir of taskDirs) {
    const candidate = NodePath.join(dir, `${taskId}.output`);
    if (yield* exists(candidate)) return candidate;
  }
  const root = claudeTaskRoot();
  if (root === undefined || sessionId === undefined) return undefined;
  const projects = yield* Effect.promise(() => NodeFSP.readdir(root).catch(() => []));
  for (const project of projects) {
    const candidate = NodePath.join(root, project, sessionId, "tasks", `${taskId}.output`);
    if (yield* exists(candidate)) return candidate;
  }
  return undefined;
});

const writersOf = (path: string) =>
  Effect.callback<ReadonlyArray<string> | undefined>((resume) => {
    NodeChildProcess.execFile(
      "lsof",
      ["-F", "pa", "--", path],
      { timeout: 5000 },
      (error, stdout) => {
        const pids = new Set<string>();
        let pid = "";
        for (const line of stdout.split("\n")) {
          if (line.startsWith("p")) pid = line.slice(1);
          else if (/^a[wu]/.test(line)) pids.add(pid);
        }
        const unknown = error !== null && (error.code !== 1 || error.killed);
        resume(Effect.succeed(unknown && pids.size === 0 ? undefined : [...pids]));
      },
    );
  });

const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

function commandText(command: string): string {
  const text = command.trim();
  return text.length > MAX_COMMAND_LENGTH
    ? `\`${text.slice(0, MAX_COMMAND_LENGTH)}\` (truncated; the full command is in the call that started it)`
    : `\`${text}\``;
}

function shellRearm(
  work: Work,
  command: string | undefined,
  outputPath: string | undefined,
  writers: ReadonlyArray<string> | undefined,
): string | undefined {
  const rerun =
    command === undefined
      ? undefined
      : work.kind === "monitor"
        ? `start a Monitor with the same command: ${commandText(command)}`
        : `run it again in the background: ${commandText(command)}`;
  if (outputPath !== undefined && (writers === undefined || writers.length > 0)) {
    const path = quote(outputPath);
    const writing = `lsof -F a -- ${path} 2>/dev/null | grep -q '^a[wu]'`;
    const join = `run \`while ${writing}; do sleep 5; done; tail -n 40 ${path}\` in the background and wait for it.`;
    const check =
      writers === undefined
        ? `If \`${writing}\` succeeds, it survived the restart: ${join}`
        : `It survived the restart (pid ${writers.join(", ")}). Rejoin it: ${join}`;
    if (rerun === undefined) return check;
    return writers === undefined
      ? `${check} Otherwise ${rerun}`
      : `${check} If that output shows it did not finish, ${rerun}`;
  }
  if (rerun === undefined) return undefined;
  const action = `Re-arm it: ${rerun}`;
  return outputPath === undefined ? action : `${action} Its earlier output is in ${outputPath}.`;
}

function subagentRearm(work: Work, driver: string): string | undefined {
  if (driver !== "claudeAgent") return undefined;
  const agentId = /\((?:id|subagent) ([^)\s]+)\)$/.exec(work.label)?.[1];
  if (agentId === undefined) return undefined;
  return `Resume it: SendMessage to "${agentId}" to finish and report back; if it is not found, relaunch it with its original prompt.`;
}

const rearm = Effect.fnUntraced(function* (
  work: ReadonlyArray<Work>,
  providerThread: Pick<OrchestrationV2ProviderThread, "driver" | "nativeThreadRef"> | undefined,
  loadItems: Effect.Effect<ReadonlyArray<OrchestrationV2TurnItem>, ProjectionStoreV2Error>,
) {
  if (work.every((entry) => entry.rearm !== undefined) || providerThread === undefined) return work;
  const driver = providerThread.driver;
  const linux = (yield* HostProcess.Platform) === "linux";
  const needsLaunches = work.some((entry) => entry.kind === "shell" || entry.kind === "monitor");
  const found = launches(needsLaunches ? yield* loadItems : []);
  const sessionId = providerThread.nativeThreadRef?.nativeId ?? undefined;
  const unmatchedMonitors = work.filter(
    (entry) =>
      entry.kind === "monitor" &&
      entry.id !== undefined &&
      !found.byTaskId.has(entry.id) &&
      !found.byItemId.has(entry.id),
  );
  const pairedMonitors =
    unmatchedMonitors.length === found.unstartedMonitors.length
      ? new Map(unmatchedMonitors.map((entry, index) => [entry, found.unstartedMonitors[index]]))
      : new Map<Work, Launch | undefined>();
  const rearmed: Array<Work> = [];
  for (const entry of work) {
    if (entry.rearm !== undefined || entry.id === undefined) {
      rearmed.push(entry);
      continue;
    }
    let action: string | undefined;
    if (entry.kind === "subagent") {
      action = subagentRearm(entry, driver);
    } else if (entry.kind === "shell" || entry.kind === "monitor") {
      const launch =
        found.byTaskId.get(entry.id) ?? found.byItemId.get(entry.id) ?? pairedMonitors.get(entry);
      const outputPath =
        launch?.outputPath ??
        (driver === "claudeAgent"
          ? yield* findOutputPath(entry.id, found.taskDirs, sessionId)
          : undefined);
      const writers = outputPath === undefined || linux ? [] : yield* writersOf(outputPath);
      action = shellRearm(entry, launch?.command, outputPath, writers);
    }
    rearmed.push(action === undefined ? entry : { ...entry, rearm: action });
  }
  return rearmed;
});

export const rearmCancelledBackgroundWork = Effect.fn("RestartBackgroundRearm.rearm")(function* (
  work: ReadonlyArray<Work>,
  projection: Pick<ProjectionRuntimeRecoveryState, "thread" | "providerThreads">,
  providerThreadId: ProviderThreadId,
  projections: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
) {
  const loadItems = projections
    .getThreadRecords(projection.thread.id, ["turnItems"], {
      turnItemTypes: ["command_execution", "dynamic_tool"],
    })
    .pipe(Effect.map((records) => records.turnItems));
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === providerThreadId,
  );
  return yield* rearm(work, providerThread, loadItems).pipe(
    Effect.catchCause(() => Effect.succeed(work)),
  );
});
