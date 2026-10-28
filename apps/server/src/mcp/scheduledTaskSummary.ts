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
    runCount: task.runCount,
    ...(task.webhook?.url == null || !mayRun ? {} : { webhookUrl: task.webhook.url }),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
  };
}
