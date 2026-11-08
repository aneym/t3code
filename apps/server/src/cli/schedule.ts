import {
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskResult,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  type OrchestratorMcpScheduledTask,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import {
  McpServerNotRunningError,
  McpServerUnreachableError,
  McpToolFailedError,
  printJson,
  reportCliErrors,
  withOwnerMcpTools,
} from "./ownerMcpTools.ts";

export class ScheduleUsageError extends Schema.TaggedError<ScheduleUsageError>()(
  "ScheduleUsageError",
  { detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const reportScheduleErrors = reportCliErrors(
  Schema.is(
    Schema.Union([
      McpServerNotRunningError,
      McpServerUnreachableError,
      McpToolFailedError,
      ScheduleUsageError,
    ]),
  ),
);

const decodeScheduledTaskIdValue = Schema.decodeUnknownEffect(ScheduledTaskId);
const decodeScheduledTaskId = (value: string) =>
  decodeScheduledTaskIdValue(value.trim()).pipe(
    Effect.mapError(
      () => new ScheduleUsageError({ detail: `'${value}' is not a scheduled task id.` }),
    ),
  );
const decodeProjectIdValue = Schema.decodeUnknownEffect(ProjectId);
const decodeProjectId = (value: string) =>
  decodeProjectIdValue(value.trim()).pipe(
    Effect.mapError(() => new ScheduleUsageError({ detail: `'${value}' is not a project id.` })),
  );

const decodeThreadIdValue = Schema.decodeUnknownEffect(ThreadId);
const DURATION_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

const scheduleFromFlags = Effect.fn("cli.schedule.scheduleFromFlags")(function* (flags: {
  readonly every: Option.Option<string>;
  readonly at: Option.Option<string>;
  readonly weekdays: Option.Option<string>;
  readonly once: Option.Option<string>;
}) {
  if ([flags.every, flags.at, flags.once].filter(Option.isSome).length !== 1)
    return yield* new ScheduleUsageError({
      detail: "Give exactly one of --every, --at or --once.",
    });
  if (Option.isSome(flags.every)) {
    const match = /^(\d+)([smhd])$/.exec(flags.every.value.trim());
    if (match === null)
      return yield* new ScheduleUsageError({
        detail: `'${flags.every.value}' is not a duration like 10m or 1h.`,
      });
    return {
      type: "interval" as const,
      everyMs: Number(match[1]) * DURATION_MS[match[2] as keyof typeof DURATION_MS],
    };
  }
  if (Option.isSome(flags.once)) return { type: "once" as const, runAt: flags.once.value };
  return {
    type: "fixed_time" as const,
    timeOfDay: Option.getOrElse(flags.at, () => ""),
    ...(Option.isSome(flags.weekdays)
      ? { weekdays: flags.weekdays.value.split(",").map((day) => Number(day.trim())) }
      : {}),
  };
});

const taskView = (task: OrchestratorMcpScheduledTask) => ({
  id: task.scheduledTaskId,
  title: task.title,
  enabled: task.enabled,
  schedule: task.schedule,
  projectId: task.projectId,
  boundThreadId: task.boundThreadId,
  lastRunAt: task.lastRunAt,
  lastRunStatus: task.lastRunStatus,
  ...(task.lastRunError === undefined ? {} : { lastRunError: task.lastRunError }),
  runCount: task.runCount,
  nextRunAt: task.nextRunAt,
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);
const taskArgument = Argument.String("scheduledTaskId").pipe(
  Argument.withDescription("Scheduled task id."),
);

const scheduleListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id. Defaults to every project."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List scheduled tasks."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const projectId = Option.isSome(flags.project)
        ? yield* decodeProjectId(flags.project.value)
        : undefined;
      yield* withOwnerMcpTools(
        "schedule",
        flags,
        Effect.fn("cli.schedule.list")(function* (tools) {
          const { tasks } = yield* tools.call(
            "list_scheduled_tasks",
            projectId === undefined ? {} : { projectId },
            OrchestratorMcpListScheduledTasksResult,
          );
          if (flags.json) {
            return yield* printJson(tasks.map(taskView));
          }
          for (const task of tasks) {
            yield* Console.log(
              [
                task.scheduledTaskId,
                (task.enabled ? "enabled" : "disabled").padEnd(8),
                task.nextRunAt ?? "-",
                task.title,
              ].join("  "),
            );
          }
        }),
      );
    }).pipe(reportScheduleErrors),
  ),
);

const scheduleCreateCommand = Command.make("create", {
  ...projectLocationFlags,
  prompt: Argument.String("prompt").pipe(Argument.withDescription("What each run does.")),
  title: Flag.String("title").pipe(Flag.withDescription("Task title."), Flag.optional),
  every: Flag.String("every").pipe(
    Flag.withDescription("Run on an interval, like 10m, 1h or 1d. At least 1m."),
    Flag.optional,
  ),
  at: Flag.String("at").pipe(
    Flag.withDescription("Run daily at this local time, like 09:00."),
    Flag.optional,
  ),
  weekdays: Flag.String("weekdays").pipe(
    Flag.withDescription("With --at, the weekdays to run on, like 1,2,3,4,5. 0 is Sunday."),
    Flag.optional,
  ),
  once: Flag.String("once").pipe(
    Flag.withDescription("Run once at this ISO time with an offset."),
    Flag.optional,
  ),
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Post each run in this thread. Defaults to a new thread per run."),
    Flag.optional,
  ),
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id. Defaults to the thread's project."),
    Flag.optional,
  ),
  disabled: Flag.Boolean("disabled").pipe(
    Flag.withDescription("Create it paused."),
    Flag.withDefault(false),
  ),
  requestId: Flag.String("request-id").pipe(
    Flag.withDescription("Key that makes a retried create return the same task."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a scheduled task, optionally bound to a thread."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const schedule = yield* scheduleFromFlags(flags);
      const thread = Option.getOrUndefined(flags.thread);
      const threadId =
        thread === undefined
          ? undefined
          : yield* decodeThreadIdValue(thread.trim()).pipe(
              Effect.mapError(
                () => new ScheduleUsageError({ detail: `'${thread}' is not a thread id.` }),
              ),
            );
      const projectId = Option.isSome(flags.project)
        ? yield* decodeProjectId(flags.project.value)
        : undefined;
      if (threadId === undefined && projectId === undefined)
        return yield* new ScheduleUsageError({ detail: "Give --thread, --project or both." });
      yield* withOwnerMcpTools(
        "schedule",
        flags,
        Effect.fn("cli.schedule.create")(function* (tools) {
          const task = yield* tools.call(
            "schedule_task",
            {
              prompt: flags.prompt,
              schedule,
              enabled: !flags.disabled,
              bindToCurrentThread: threadId !== undefined,
              ...(threadId === undefined ? {} : { threadId }),
              ...(projectId === undefined ? {} : { projectId }),
              ...Option.match(flags.title, { onNone: () => ({}), onSome: (title) => ({ title }) }),
              ...Option.match(flags.requestId, {
                onNone: () => ({}),
                onSome: (clientRequestId) => ({ clientRequestId }),
              }),
            },
            OrchestratorMcpScheduleTaskResult,
          );
          yield* flags.json
            ? printJson(taskView(task))
            : Console.log(`${task.scheduledTaskId}  next ${task.nextRunAt ?? "-"}  ${task.title}`);
        }),
      );
    }).pipe(reportScheduleErrors),
  ),
);

const scheduleDeleteCommand = Command.make("delete", {
  ...projectLocationFlags,
  scheduledTaskId: taskArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Delete a scheduled task. It stops at once."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const scheduledTaskId = yield* decodeScheduledTaskId(flags.scheduledTaskId);
      yield* withOwnerMcpTools(
        "schedule",
        flags,
        Effect.fn("cli.schedule.delete")(function* (tools) {
          const result = yield* tools.call(
            "delete_scheduled_task",
            { scheduledTaskId },
            OrchestratorMcpDeleteScheduledTaskResult,
          );
          if (!result.deleted) {
            return yield* new McpToolFailedError({
              tool: "delete_scheduled_task",
              detail: `Scheduled task ${scheduledTaskId} was not deleted.`,
            });
          }
          yield* flags.json ? printJson(result) : Console.log("Deleted.");
        }),
      );
    }).pipe(reportScheduleErrors),
  ),
);

const makeSetEnabledCommand = (enabled: boolean) =>
  Command.make(enabled ? "enable" : "disable", {
    ...projectLocationFlags,
    scheduledTaskId: taskArgument,
    json: jsonFlag,
  }).pipe(
    Command.withDescription(
      enabled ? "Resume a paused scheduled task." : "Pause a scheduled task without deleting it.",
    ),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const scheduledTaskId = yield* decodeScheduledTaskId(flags.scheduledTaskId);
        yield* withOwnerMcpTools(
          "schedule",
          flags,
          Effect.fn("cli.schedule.setEnabled")(function* (tools) {
            const task = yield* tools.call(
              "schedule_task",
              { scheduledTaskId, enabled },
              OrchestratorMcpScheduleTaskResult,
            );
            yield* flags.json
              ? printJson(taskView(task))
              : Console.log(enabled ? "Enabled." : "Disabled.");
          }),
        );
      }).pipe(reportScheduleErrors),
    ),
  );

export const scheduleCommand = Command.make("schedule").pipe(
  Command.withDescription(
    "Create, list, pause, resume, and delete scheduled tasks on the running server.",
  ),
  Command.withSubcommands([
    scheduleListCommand,
    scheduleCreateCommand,
    scheduleDeleteCommand,
    makeSetEnabledCommand(false),
    makeSetEnabledCommand(true),
  ]),
);
