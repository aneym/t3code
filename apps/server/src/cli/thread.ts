import { threadSendAllCommand } from "./threadSendAll.ts";
import {
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestrationV2DispatchCommandResult,
  IsoDateTime,
  OrchestratorMcpThreadStatus,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestratorMcpThreadListItem,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { ThreadRestartResult } from "../mcp/toolkits/thread/tools.ts";
import { projectLocationFlags } from "./config.ts";
import { printJson, withOwnerMcpTools, type OwnerMcpTools } from "./ownerMcpTools.ts";
import {
  ThreadProjectNotFoundError,
  ThreadUsageError,
  decodeThreadId,
  jsonFlag,
  messageArgument,
  readMessageArgument,
  reportThreadErrors,
  threadArgument,
  waitFlag,
} from "./threadCommon.ts";
import { finishRun, readFullText, readThreadOnly, readTimeline } from "./threadRun.ts";
import { threadSendCommand } from "./threadSend.ts";

const TITLE_MAX_CHARS = 80;

const ProjectListResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({ id: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
  ),
  nextCursor: Schema.NullOr(Schema.Int),
});

const ThreadLaunchResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  runId: Schema.NullOr(RunId),
});

const listAllProjects = Effect.fn("cli.thread.listAllProjects")(function* (tools: OwnerMcpTools) {
  const projects: Array<(typeof ProjectListResult.Type)["projects"][number]> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: typeof ProjectListResult.Type = yield* tools.call(
      "t3_project_list",
      { cursor, limit: 100 },
      ProjectListResult,
    );
    projects.push(...page.projects);
    cursor = page.nextCursor;
  }
  return projects;
});

/** A project id, or a path inside a project's folder (deepest project wins). */
const resolveProject = Effect.fn("cli.thread.resolveProject")(function* (
  tools: OwnerMcpTools,
  identifier: string,
) {
  const projects = yield* listAllProjects(tools);
  const byId = projects.find((project) => project.id === identifier);
  if (byId !== undefined) return byId;

  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  // Stored roots keep the path the project was added with, which may pass
  // through a symlink (macOS /tmp), so both sides compare as real paths.
  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  const target = yield* realPath(path.resolve(yield* HostProcess.WorkingDirectory, identifier));
  const roots = yield* Effect.forEach(projects, (project) =>
    Effect.map(realPath(project.workspaceRoot), (root) => ({ project, root })),
  );
  const containing = roots
    .filter(({ root }) => {
      const relative = path.relative(root, target);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    })
    .toSorted((left, right) => right.root.length - left.root.length)[0];
  if (containing === undefined) {
    return yield* new ThreadProjectNotFoundError({ identifier });
  }
  return containing.project;
});

const titleFromMessage = (message: string) => {
  const firstLine = message.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.length > TITLE_MAX_CHARS
    ? `${firstLine.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
    : firstLine;
};

const launchWorkspaceStrategy = (input: {
  readonly worktree: Option.Option<string>;
  readonly branch: Option.Option<string>;
}) =>
  Option.match(input.worktree, {
    onNone: () =>
      Option.isSome(input.branch)
        ? Effect.fail(new ThreadUsageError({ detail: "--branch needs --worktree <base-ref>." }))
        : Effect.void,
    onSome: (baseRef) =>
      Effect.succeed({
        type: "worktree" as const,
        baseRef,
        ...Option.match(input.branch, { onNone: () => ({}), onSome: (branch) => ({ branch }) }),
      }),
  });

const decodeRunIdValue = Schema.decodeUnknownEffect(RunId);
const decodeTitle = Schema.decodeUnknownEffect(TrimmedNonEmptyString);
const decodeIsoDateTime = Schema.decodeEffect(IsoDateTime);
const decodeRunId = (value: string) =>
  decodeRunIdValue(value.trim()).pipe(
    Effect.mapError(() => new ThreadUsageError({ detail: `'${value}' is not a run id.` })),
  );

const decodeStatusList = Schema.decodeUnknownEffect(
  Schema.Array(OrchestratorMcpThreadStatus).check(Schema.isMaxLength(10)),
);

const decodeStatuses = (value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => Effect.void,
    onSome: (text) =>
      decodeStatusList(text.split(",").map((status) => status.trim())).pipe(
        Effect.mapError(() => new ThreadUsageError({ detail: `'${text}' is not a status list.` })),
      ),
  });

const threadListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or a path inside the project. Defaults to this directory."),
    Flag.withDefault("."),
  ),
  subagents: Flag.Literals("subagents", ["exclude", "include", "only"]).pipe(
    Flag.withDescription(
      "Delegated child threads: left out by default, included with include, or listed alone with only.",
    ),
    Flag.withDefault("exclude"),
  ),
  status: Flag.String("status").pipe(
    Flag.withDescription(
      "Only threads in these comma-separated statuses, such as failed or running.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List a project's threads, newest first."),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "thread",
      flags,
      Effect.fn("cli.thread.list")(function* (tools) {
        const project = yield* resolveProject(tools, flags.project);
        const statuses = yield* decodeStatuses(flags.status);
        const threads: Array<OrchestratorMcpThreadListItem> = [];
        let cursor: number | null = 0;
        while (cursor !== null) {
          const page: OrchestratorMcpThreadListResult = yield* tools.call(
            "t3_thread_list",
            {
              projectId: project.id,
              includeSubagents: flags.subagents === "include",
              onlySubagents: flags.subagents === "only",
              ...(statuses === undefined ? {} : { statuses }),
              limit: 100,
              cursor,
            },
            OrchestratorMcpThreadListResult,
          );
          threads.push(...page.threads);
          cursor = page.nextCursor;
        }
        if (flags.json) {
          return yield* printJson(threads);
        }
        for (const thread of threads) {
          const child = thread.relationshipToParent === "subagent" ? "  (subagent)" : "";
          yield* Console.log(
            `${thread.threadId}  ${thread.status.padEnd(11)}  ${thread.title}${child}`,
          );
        }
      }),
    ).pipe(reportThreadErrors),
  ),
);

const threadStartCommand = Command.make("start", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or a path inside the project, such as ."),
  ),
  message: messageArgument,
  title: Flag.String("title").pipe(
    Flag.withDescription("Thread title. Defaults to the message's first line."),
    Flag.optional,
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Provider instance id. Pass with --model."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("Model slug. Defaults to the project's default model."),
    Flag.optional,
  ),
  worktree: Flag.String("worktree").pipe(
    Flag.withDescription(
      "Run in a new git worktree based on this branch, tag, or commit, instead of the project folder.",
    ),
    Flag.optional,
  ),
  branch: Flag.String("branch").pipe(
    Flag.withDescription("Branch name for the new worktree."),
    Flag.optional,
  ),
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start a thread in a project and print its id."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const message = yield* readMessageArgument(flags.message);
      const workspaceStrategy = yield* launchWorkspaceStrategy(flags);
      if (Option.isSome(flags.provider) !== Option.isSome(flags.model)) {
        return yield* new ThreadUsageError({ detail: "--provider and --model go together." });
      }
      const title = yield* decodeTitle(
        Option.getOrElse(flags.title, () => titleFromMessage(message)),
      ).pipe(Effect.mapError(() => new ThreadUsageError({ detail: "The title is empty." })));
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.start")(function* (tools) {
          const project = yield* resolveProject(tools, flags.project);
          const launched = yield* tools.call(
            "t3_thread_launch",
            {
              projectId: project.id,
              title,
              message,
              ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
              ...(Option.isSome(flags.provider) && Option.isSome(flags.model)
                ? {
                    modelSelection: {
                      instanceId: flags.provider.value,
                      model: flags.model.value,
                    },
                  }
                : {}),
            },
            ThreadLaunchResult,
          );
          if (flags.wait && launched.runId !== null) {
            if (!flags.json) yield* Console.error(`Thread ${launched.threadId}`);
            return yield* finishRun(tools, {
              threadId: launched.threadId,
              runId: launched.runId,
              json: flags.json,
            });
          }
          yield* flags.json ? printJson(launched) : Console.log(launched.threadId);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadRestartCommand = Command.make("restart", {
  ...projectLocationFlags,
  thread: threadArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Restart a thread's agent session so its next turn reloads MCP servers, tools and settings. History, queue and child threads stay. A running thread restarts after its current turn.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.restart")(function* (tools) {
          const restart = yield* tools.call("t3_thread_restart", { threadId }, ThreadRestartResult);
          if (flags.json) return yield* printJson(restart);
          yield* Console.log(
            restart.appliesAt === "next_turn"
              ? "Restart requested. The next turn starts a fresh session."
              : restart.appliesAt === "after_current_turn"
                ? "Restart requested. It applies after the current turn."
                : `Restart requested. It waits for ${restart.backgroundTasks} background tasks to finish.`,
          );
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const ThreadOrganizeResult = Schema.Union([
  OrchestrationV2DispatchCommandResult,
  Schema.Struct({ settlesWhenTurnEnds: Schema.Literal(true) }),
]);

const threadOrganizeCommand = (
  action: "archive" | "unarchive" | "settle" | "unsettle" | "pin" | "unpin" | "snooze" | "unsnooze",
) =>
  Command.make(action, {
    ...projectLocationFlags,
    thread: threadArgument,
    snoozedUntil: Flag.String("snoozed-until").pipe(
      Flag.withDescription("ISO timestamp until which the thread stays snoozed."),
      Flag.optional,
    ),
    json: jsonFlag,
  }).pipe(
    Command.withDescription(`${action[0]!.toUpperCase()}${action.slice(1)} a thread.`),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const threadId = yield* decodeThreadId(flags.thread);
        yield* withOwnerMcpTools(
          "thread",
          flags,
          Effect.fn(`cli.thread.${action}`)(function* (tools) {
            const result = yield* tools.call(
              "t3_thread_organize",
              {
                threadId,
                action,
                ...(Option.isSome(flags.snoozedUntil)
                  ? {
                      snoozedUntil: yield* decodeIsoDateTime(flags.snoozedUntil.value),
                    }
                  : {}),
              },
              ThreadOrganizeResult,
            );
            yield* flags.json ? printJson(result) : Console.log("Done.");
          }),
        );
      }).pipe(reportThreadErrors),
    ),
  );
const threadPromoteCommand = Command.make("promote", {
  ...projectLocationFlags,
  thread: threadArgument,
  queuedRunId: Argument.String("queuedRunId").pipe(
    Argument.withDescription("Run id of the queued message to promote."),
  ),
  targetRunId: Argument.String("targetRunId").pipe(
    Argument.withDescription("Run id of the running turn to steer."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Send one queued message now as steering to the given running turn."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const queuedRunId = yield* decodeRunId(flags.queuedRunId);
      const targetRunId = yield* decodeRunId(flags.targetRunId);
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.promote")(function* (tools) {
          const promoted = yield* tools.call(
            "t3_queue",
            { action: "promote_to_steer", threadId, queuedRunId, targetRunId },
            OrchestrationV2DispatchCommandResult,
          );
          yield* flags.json ? printJson(promoted) : Console.log("Promoted.");
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadUnqueueCommand = Command.make("unqueue", {
  ...projectLocationFlags,
  thread: threadArgument,
  queuedRunId: Argument.String("queuedRunId").pipe(
    Argument.withDescription("Run id of the queued message to cancel."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Cancel one queued message before its turn starts."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const queuedRunId = yield* decodeRunId(flags.queuedRunId);
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.unqueue")(function* (tools) {
          const cancelled = yield* tools.call(
            "t3_queue",
            { action: "cancel", threadId, queuedRunId },
            OrchestrationV2DispatchCommandResult,
          );
          yield* flags.json ? printJson(cancelled) : Console.log("Unqueued.");
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadInterruptCommand = Command.make("interrupt", {
  ...projectLocationFlags,
  thread: threadArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Interrupt a thread's running turn without starting a new turn."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.interrupt")(function* (tools) {
          const interrupted = yield* tools.call(
            "t3_thread_interrupt",
            { threadId },
            OrchestratorMcpThreadInterruptResult,
          );
          if (flags.json) {
            yield* printJson(interrupted);
          } else if (interrupted.status === "no_active_run") {
            yield* Console.log("Nothing is running.");
          } else if (interrupted.status === "interrupt_requested") {
            yield* Console.log("Interrupted.");
          } else {
            yield* Console.log(`Already stopped (${interrupted.status}).`);
          }
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadShowCommand = Command.make("show", {
  ...projectLocationFlags,
  thread: threadArgument,
  messages: Flag.Int("messages").pipe(
    Flag.withDescription("How many of the latest messages to print."),
    Flag.withDefault(10),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show a thread's state and its latest messages."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.show")(function* (tools) {
          const { thread, items } =
            flags.messages > 0
              ? yield* readTimeline(tools, threadId, "messages")
              : yield* readThreadOnly(tools, threadId);
          const conversation = items.filter(
            (item) => item.type === "user_message" || item.type === "assistant_message",
          );
          const latest = conversation.slice(Math.max(0, conversation.length - flags.messages));
          const messages = yield* Effect.forEach(latest, (item) =>
            readFullText(tools, threadId, item).pipe(
              Effect.map((text) => ({
                role: item.type === "user_message" ? "user" : "assistant",
                runId: item.runId,
                text,
              })),
            ),
          );
          if (flags.json) {
            return yield* printJson({ thread, messages });
          }
          yield* Console.log(thread.title);
          yield* Console.log(
            [thread.threadId, thread.status, `${thread.providerInstanceId}/${thread.model}`].join(
              "  ",
            ),
          );
          if (thread.worktreePath !== null) {
            yield* Console.log(`${thread.branch ?? "(no branch)"}  ${thread.worktreePath}`);
          }
          if (thread.pendingRequestCount > 0) {
            yield* Console.log(`Waiting for ${thread.pendingRequestCount} answer(s).`);
          }
          for (const entry of messages) {
            yield* Console.log(`\n[${entry.role}]\n${entry.text}`);
          }
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadMoveCommand = Command.make("move", {
  ...projectLocationFlags,
  thread: threadArgument,
  project: Argument.String("project"),
}).pipe(
  Command.withDescription("Move a thread to another project."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withOwnerMcpTools("thread", flags, (tools) =>
        Effect.gen(function* () {
          const target = yield* resolveProject(tools, flags.project);
          const result = yield* tools.call(
            "t3_thread_move",
            { threadId, projectId: target.id },
            OrchestrationV2DispatchCommandResult,
          );
          yield* Console.log(`${threadId} moved to ${target.title}`);
          return result;
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Start, message, and read threads on the running server."),
  Command.withSubcommands([
    threadListCommand,
    threadStartCommand,
    threadSendCommand,
    threadRestartCommand,
    threadPromoteCommand,
    threadSendAllCommand,
    threadUnqueueCommand,
    threadInterruptCommand,
    threadShowCommand,
    ...(
      ["archive", "unarchive", "settle", "unsettle", "pin", "unpin", "snooze", "unsnooze"] as const
    ).map(threadOrganizeCommand),
    threadMoveCommand,
  ]),
);
