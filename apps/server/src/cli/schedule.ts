import {
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskResult,
  ProjectId,
  ScheduledTaskId,
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

const taskView = (task: OrchestratorMcpScheduledTask) => ({
  id: task.scheduledTaskId,
  title: task.title,
  enabled: task.enabled,
  schedule: task.schedule,
  projectId: task.projectId,
  boundThreadId: task.boundThreadId,
  lastRunAt: task.lastRunAt,
  lastRunStatus: task.lastRunStatus,
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
              "update_scheduled_task",
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
  Command.withDescription("List, pause, resume, and delete scheduled tasks on the running server."),
  Command.withSubcommands([
    scheduleListCommand,
    scheduleDeleteCommand,
    makeSetEnabledCommand(false),
    makeSetEnabledCommand(true),
  ]),
);
