import * as DateTime from "effect/DateTime";
import type { ScheduledTask, ScheduledTaskUpsertSchedule } from "@t3tools/contracts";

export function onceScheduleLabel(at: string): string {
  return `Once on ${DateTime.formatLocal(DateTime.makeUnsafe(at), { dateStyle: "medium", timeStyle: "short" })}`;
}

export function scheduledTaskStateLabel(task: ScheduledTask): string {
  if (task.enabled) return "Enabled";
  if (task.schedule.type !== "once") return "Paused";
  if (task.lastRunStatus === "running") return "Running";
  return task.runCount > 0 && task.nextRunAt === null ? "Done" : "Paused";
}

export function localOnceInput(at: string): string {
  const local = DateTime.makeZonedUnsafe(at, { timeZone: DateTime.zoneMakeLocal() });
  return DateTime.toDate(local).toISOString().slice(0, -1);
}

export function onceScheduleFromInput(value: string): ScheduledTaskUpsertSchedule | null {
  if (!value.trim()) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis)
    ? { type: "once", at: DateTime.formatIso(DateTime.makeUnsafe(millis)) }
    : null;
}
