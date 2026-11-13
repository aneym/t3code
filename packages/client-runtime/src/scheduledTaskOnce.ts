import type { ScheduledTask } from "@t3tools/contracts";

export function scheduledTaskStateLabel(task: ScheduledTask): string {
  if (task.enabled) return "Enabled";
  if (task.schedule.type !== "once") return "Paused";
  if (task.lastRunStatus === "running") return "Running";
  return task.runCount > 0 && task.nextRunAt === null ? "Done" : "Paused";
}
