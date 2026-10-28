import { AutomationThreadRows, automationThreadsWithoutJobs } from "./AutomationThreadRows";
import {
  type EnvironmentThreadShell,
  resolveThreadWorkingStartedAt,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CalendarClockIcon, CircleAlertIcon, CircleDashedIcon, SettingsIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import { useAutomations } from "../../hooks/useAutomations";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";
import { SHELF_MORE_ROW_CLASS_NAME } from "../sidebar/shelfMoreRow";
import { WorkingDuration } from "../sidebar/WorkingDuration";
import { formatRelativeTimeLabel } from "../../timestampFormat";

const AUTOMATIONS_SHELF_EXPANDED_KEY = "t3code:sidebar:automations-expanded";

const ROW_CLASS =
  "group/automation-row flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/75 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function runRequestedAt(thread: EnvironmentThreadShell): string {
  return thread.latestRun?.requestedAt ?? thread.createdAt;
}

function resolveRunThread(
  environmentId: EnvironmentId,
  task: ScheduledTask,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell | null {
  let latest: EnvironmentThreadShell | null = null;
  for (const thread of threads) {
    if (thread.environmentId !== environmentId) continue;
    if (thread.id !== task.threadId && thread.automationTaskId !== task.id) continue;
    if (threadRuntimeIsActive(thread.runtime)) return thread;
    if (latest === null || runRequestedAt(thread) > runRequestedAt(latest)) latest = thread;
  }
  return latest;
}

function LastRunLabel({ value }: { readonly value: string }) {
  const nowMinute = useNowMinute();
  return formatRelativeTimeLabel(value, Date.parse(`${nowMinute}:00.000Z`));
}

export function SidebarAutomationJobs({ onNavigate }: { readonly onNavigate: () => void }) {
  const automations = useAutomations();
  const environments = useEnvironmentIdentities();
  const threads = useQuietThreadShells();
  const [expanded, setExpanded] = useLocalStorage(
    AUTOMATIONS_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const standaloneThreads = automationThreadsWithoutJobs(threads, automations);
  if (automations.length === 0 && standaloneThreads.length === 0) return null;
  const grouped = new Map<
    string,
    { environmentId: EnvironmentId; task: ScheduledTask; count: number }
  >();
  for (const automation of automations) {
    const key = `${automation.environmentId}:${automation.task.threadId ?? automation.task.id}`;
    const current = grouped.get(key);
    if (current) current.count += 1;
    else grouped.set(key, { ...automation, count: 1 });
  }
  const rows = [...grouped.values()];
  const titleCounts = new Map<string, number>();
  for (const { task } of rows) titleCounts.set(task.title, (titleCounts.get(task.title) ?? 0) + 1);
  return (
    <div className="mx-0.5">
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        data-testid="sidebar-automations-shelf-toggle"
        accessory={
          <span className="font-normal tabular-nums">{rows.length + standaloneThreads.length}</span>
        }
      >
        Automations
      </CollapsibleSectionHeader>
      {expanded ? (
        <ul aria-label="Automation jobs" className="flex flex-col">
          {rows.map(({ environmentId, task, count }) => (
            <AutomationJobRow
              key={`${environmentId}:${task.id}`}
              environmentId={environmentId}
              task={task}
              count={count}
              machine={
                (titleCounts.get(task.title) ?? 0) > 1
                  ? (environments.find((environment) => environment.environmentId === environmentId)
                      ?.label ?? null)
                  : null
              }
              runThread={resolveRunThread(environmentId, task, threads)}
              onNavigate={onNavigate}
            />
          ))}
          <AutomationThreadRows threads={standaloneThreads} onNavigate={onNavigate} />
          <li className="list-none">
            <Link
              to="/settings/scheduled-tasks"
              search={{ machine: undefined, project: undefined, checkout: undefined }}
              className={SHELF_MORE_ROW_CLASS_NAME}
              onClick={onNavigate}
            >
              <SettingsIcon aria-hidden className="size-4 shrink-0" />
              Manage automations
            </Link>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

function AutomationJobRow({
  environmentId,
  task,
  count,
  machine,
  runThread,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly count: number;
  readonly machine: string | null;
  readonly runThread: EnvironmentThreadShell | null;
  readonly onNavigate: () => void;
}) {
  const working = runThread !== null && threadRuntimeIsActive(runThread.runtime);
  const failed =
    task.lastRunStatus === "failed" || (!working && runThread?.runtime?.status === "failed");
  const content = (
    <>
      <CalendarClockIcon
        aria-hidden
        className="size-4 shrink-0 opacity-40 transition-opacity group-hover/automation-row:opacity-100 group-focus-visible/automation-row:opacity-100"
      />
      <span className="min-w-0 flex-1 truncate font-normal text-secondary-label group-hover/automation-row:text-foreground group-focus-visible/automation-row:text-foreground">
        {task.title}
        {count > 1 ? ` (${count})` : null}
        {machine ? <span> · {machine}</span> : null}
      </span>
      <span className="ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end text-xs tabular-nums text-secondary-label">
        {working ? (
          <span className="inline-flex items-center gap-1 font-medium text-info-foreground">
            <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
            Working
            <span aria-hidden>
              <WorkingDuration startedAt={resolveThreadWorkingStartedAt(runThread)} />
            </span>
          </span>
        ) : !task.enabled ? (
          "Paused"
        ) : failed ? (
          <span className="inline-flex items-center gap-1 font-medium text-error-foreground">
            <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
            Failed
          </span>
        ) : task.schedule.type !== "webhook" && task.nextRunAt ? (
          <ScheduledRelativeLabel value={task.nextRunAt} />
        ) : task.lastRunAt ? (
          <LastRunLabel value={task.lastRunAt} />
        ) : null}
      </span>
    </>
  );
  return (
    <li className="list-none">
      {runThread === null ? (
        <Link
          to="/settings/scheduled-tasks"
          search={{
            machine: undefined,
            project: undefined,
            checkout: undefined,
            environmentId,
            taskId: task.id,
          }}
          className={ROW_CLASS}
          onClick={onNavigate}
        >
          {content}
        </Link>
      ) : (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: runThread.id }}
          className={ROW_CLASS}
          onClick={onNavigate}
        >
          {content}
        </Link>
      )}
    </li>
  );
}
