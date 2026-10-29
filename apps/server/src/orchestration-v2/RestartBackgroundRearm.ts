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
import * as Effect from "effect/Effect";

import type {
  ProjectionRuntimeRecoveryState,
  ProjectionStoreV2Error,
  ProjectionStoreV2Shape,
} from "./ProjectionStore.ts";

type Work = OrchestrationV2RestartCancelledBackgroundWork;

const MAX_COMMAND_LENGTH = 1000;
const BASH_OUTPUT_PATH = /Output is being written to: (\S+?\.output)/;

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
  for (const item of items) {
    const outputPath =
      item.type === "command_execution" ? BASH_OUTPUT_PATH.exec(item.output ?? "")?.[1] : undefined;
    if (outputPath !== undefined) taskDirs.add(NodePath.dirname(outputPath));
    const launch = { command: launchCommand(item), outputPath };
    byItemId.set(item.id, launch);
    const taskId = launchedTaskId(item);
    if (taskId !== undefined) byTaskId.set(taskId, launch);
  }
  return { byTaskId, byItemId, taskDirs };
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
  Effect.callback<ReadonlyArray<string>>((resume) => {
    NodeChildProcess.execFile("lsof", ["-t", "--", path], { timeout: 5000 }, (_error, stdout) =>
      resume(Effect.succeed(stdout.split("\n").filter((pid) => /^\d+$/.test(pid)))),
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
  writers: ReadonlyArray<string>,
): string | undefined {
  const rerun =
    command === undefined
      ? undefined
      : work.kind === "monitor"
        ? `start a Monitor with the same command: ${commandText(command)}`
        : `run it again in the background: ${commandText(command)}`;
  if (outputPath !== undefined && writers.length > 0) {
    const wait = `while lsof -t -- ${quote(outputPath)} >/dev/null 2>&1; do sleep 5; done; tail -n 40 ${quote(outputPath)}`;
    return [
      `It survived the restart (pid ${writers.join(", ")}). Rejoin it: run \`${wait}\` in the background and wait for it.`,
      rerun === undefined ? undefined : `If that output shows it did not finish, ${rerun}`,
    ]
      .filter((part) => part !== undefined)
      .join(" ");
  }
  if (rerun === undefined) return undefined;
  const action = `Re-arm it: ${rerun}`;
  return outputPath === undefined ? action : `${action} Its earlier output is in ${outputPath}.`;
}

function subagentRearm(work: Work, driver: string): string | undefined {
  if (driver !== "claudeAgent") return undefined;
  const agentId = /\((?:id|subagent) ([^)\s]+)\)$/.exec(work.label)?.[1];
  if (agentId === undefined) return undefined;
  return `Resume it: SendMessage to "${agentId}" asking it to finish its task and report back; if SendMessage cannot find it, launch it again with its original prompt.`;
}

const rearm = Effect.fnUntraced(function* (
  work: ReadonlyArray<Work>,
  providerThread: Pick<OrchestrationV2ProviderThread, "driver" | "nativeThreadRef"> | undefined,
  loadItems: Effect.Effect<ReadonlyArray<OrchestrationV2TurnItem>, ProjectionStoreV2Error>,
) {
  if (work.every((entry) => entry.rearm !== undefined) || providerThread === undefined) return work;
  const driver = providerThread.driver;
  const needsLaunches = work.some((entry) => entry.kind === "shell" || entry.kind === "monitor");
  const found = launches(needsLaunches ? yield* loadItems : []);
  const sessionId = providerThread.nativeThreadRef?.nativeId ?? undefined;
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
      const launch = found.byTaskId.get(entry.id) ?? found.byItemId.get(entry.id);
      const outputPath =
        launch?.outputPath ??
        (driver === "claudeAgent"
          ? yield* findOutputPath(entry.id, found.taskDirs, sessionId)
          : undefined);
      const writers = outputPath === undefined ? [] : yield* writersOf(outputPath);
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
