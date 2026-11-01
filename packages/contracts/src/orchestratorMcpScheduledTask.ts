import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "./baseSchemas.ts";
import { OrchestratorMcpEnvironmentTarget } from "./orchestratorMcp.ts";
import { ScheduledTaskRunStatus, ScheduledTaskSchedule } from "./scheduledTask.ts";

export const OrchestratorMcpScheduledTask = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  runCount: NonNegativeInt,
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL for the sender. Absent: no T3 Connect tunnel. The user must enable T3 Connect remote access.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])),
});
export type OrchestratorMcpScheduledTask = typeof OrchestratorMcpScheduledTask.Type;

export const OrchestratorMcpScheduleTaskResult = OrchestratorMcpScheduledTask;
export type OrchestratorMcpScheduleTaskResult = typeof OrchestratorMcpScheduleTaskResult.Type;

export const OrchestratorMcpListScheduledTasksInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  allProjects: Schema.optional(Schema.Boolean).annotate({
    description: "List every project in this environment. Do not combine with projectId.",
  }),
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Default: your thread's project, or all outside a thread. For every project, use allProjects=true instead.",
    }),
  ),
});
export type OrchestratorMcpListScheduledTasksInput =
  typeof OrchestratorMcpListScheduledTasksInput.Type;

export const OrchestratorMcpListScheduledTasksResult = Schema.Struct({
  tasks: Schema.Array(OrchestratorMcpScheduledTask),
  projectId: Schema.NullOr(ProjectId).annotate({
    description:
      "The listed project, or null for every project. Use allProjects=true to remove project scoping.",
  }),
  next: Schema.NullOr(Schema.String),
  total: NonNegativeInt.annotate({
    description: "Task count in the selected scope; no pagination or enabled-only filter.",
  }),
  environmentTotal: NonNegativeInt.annotate({
    description: "Task count across every project, including tasks outside the selected scope.",
  }),
});
export type OrchestratorMcpListScheduledTasksResult =
  typeof OrchestratorMcpListScheduledTasksResult.Type;

export const OrchestratorMcpDeleteScheduledTaskInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  scheduledTaskId: ScheduledTaskId,
});
export type OrchestratorMcpDeleteScheduledTaskInput =
  typeof OrchestratorMcpDeleteScheduledTaskInput.Type;

export const OrchestratorMcpDeleteScheduledTaskResult = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  deleted: Schema.Boolean,
});
export type OrchestratorMcpDeleteScheduledTaskResult =
  typeof OrchestratorMcpDeleteScheduledTaskResult.Type;
