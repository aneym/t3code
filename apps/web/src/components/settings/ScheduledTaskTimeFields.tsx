import {
  localOnceInput,
  onceScheduleFromInput,
} from "@t3tools/client-runtime/scheduled-task-once";
import type { Dispatch, SetStateAction } from "react";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import type { DraftState } from "./scheduledTasksSettings.logic";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

export function ScheduledTaskTimeFields({
  draft,
  setDraft,
}: {
  readonly draft: DraftState;
  readonly setDraft: Dispatch<SetStateAction<DraftState>>;
}) {
  if (draft.scheduleMode === "once")
    return (
      <div className="space-y-2">
        <Label htmlFor="scheduled-task-once">Run once at</Label>
        <Input
          id="scheduled-task-once"
          type="datetime-local"
          nativeInput
          step="0.001"
          value={draft.onceAt ? localOnceInput(draft.onceAt) : ""}
          onChange={(event) => {
            const onceAt = onceScheduleFromInput(event.target.value)?.at ?? "";
            setDraft((current) => ({ ...current, onceAt }));
          }}
        />
        <p className="text-xs text-muted-foreground">
          Your local time. Disables after one run. Change its time or enable it again to re-arm.
        </p>
      </div>
    );
  return draft.scheduleMode === "fixed" ? (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <Label htmlFor="scheduled-task-time">Run at</Label>
        <Input
          type="time"
          id="scheduled-task-time"
          nativeInput
          className="w-32"
          value={draft.timeOfDay}
          onChange={(event) =>
            setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
          }
        />
        <span className="text-xs text-muted-foreground">on</span>
      </div>
      <ToggleGroup
        multiple
        variant="outline"
        size="sm"
        aria-label="Days to run"
        value={[...draft.weekdays].map(String)}
        onValueChange={(values) => {
          if (values.length === 0) return;
          setDraft((current) => ({
            ...current,
            weekdays: new Set(values.map(Number)),
          }));
        }}
      >
        {WEEKDAY_ORDER.map((day) => (
          <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
            {WEEKDAY_SHORT[day]}
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  ) : (
    <div className="flex items-center gap-2">
      <Label htmlFor="scheduled-task-interval">Run every</Label>
      <Input
        type="number"
        id="scheduled-task-interval"
        nativeInput
        min={1}
        step="any"
        className="w-24"
        value={draft.intervalMinutes}
        onChange={(event) =>
          setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
        }
      />
      <span className="text-xs text-muted-foreground">minutes</span>
    </div>
  );
}
