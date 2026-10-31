import * as Schema from "effect/Schema";
import { ScheduledTaskUpsertSchedule } from "./scheduledTask.ts";

export const OrchestratorMcpSchedule = Schema.Union([
  ScheduledTaskUpsertSchedule,
  Schema.fromJsonString(ScheduledTaskUpsertSchedule).annotate({
    description: "JSON-text schedule. Prefer the object form.",
  }),
]).annotate({
  description:
    "One-time: {type:'once',at:ISO datetime}. Recurring: {type:'interval',everyMs} or {type:'fixed_time',timeOfDay,weekdays?}. Webhook: {type:'webhook'}.",
});
