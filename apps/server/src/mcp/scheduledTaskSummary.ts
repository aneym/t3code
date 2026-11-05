import type { OrchestratorMcpScheduledTask, ScheduledTask } from "@t3tools/contracts";

export function scheduledTaskSummary(
  task: ScheduledTask,
  mayRun: boolean,
): OrchestratorMcpScheduledTask {
  return {
    scheduledTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    boundThreadId: task.threadId,
    schedule: task.schedule,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastRunStatus: task.lastRunStatus,
    ...(task.lastRunError === null ? {} : { lastRunError: task.lastRunError }),
    runCount: task.runCount,
    ...(task.blockedByPolicy === undefined ? {} : { blockedByPolicy: task.blockedByPolicy }),
    ...(task.webhook?.url == null || !mayRun || task.blockedByPolicy !== undefined
      ? {}
      : { webhookUrl: task.webhook.url }),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
  };
}
