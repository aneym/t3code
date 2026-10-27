import {
  type EnvironmentThreadShell,
  resolveThreadWorkingStartedAt,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon, CircleDashedIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import { useAutomations } from "../../hooks/useAutomations";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";
import { WorkingDuration } from "../sidebar/WorkingDuration";
import { formatRelativeTimeLabel } from "../../timestampFormat";

const AUTOMATIONS_SHELF_EXPANDED_KEY = "t3code:sidebar:automations-expanded";

const ROW_CLASS =
  "flex min-w-0 flex-col rounded-md px-2 py-1 outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset";

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
  if (automations.length === 0) return null;
  const titleCounts = new Map<string, number>();
  for (const { task } of automations) {
    titleCounts.set(task.title, (titleCounts.get(task.title) ?? 0) + 1);
  }
  return (
    <div className="mx-0.5">
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        data-testid="sidebar-automations-shelf-toggle"
        accessory={<span className="font-normal tabular-nums">{automations.length}</span>}
      >
        Automations
      </CollapsibleSectionHeader>
      {expanded ? (
        <ul aria-label="Automation jobs" className="flex flex-col">
          {automations.map(({ environmentId, task }) => (
            <AutomationJobRow
              key={`${environmentId}:${task.id}`}
              environmentId={environmentId}
              task={task}
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
          <li>
            <Link
              to="/settings/scheduled-tasks"
              search={{ machine: undefined, project: undefined, checkout: undefined }}
              className="block rounded-md px-2 py-1 text-secondary-label text-xs hover:bg-sidebar-row-hover"
              onClick={onNavigate}
            >
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
  machine,
  runThread,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly machine: string | null;
  readonly runThread: EnvironmentThreadShell | null;
  readonly onNavigate: () => void;
}) {
  const working = runThread !== null && threadRuntimeIsActive(runThread.runtime);
  // The scheduler marks a run succeeded once its prompt is dispatched, so a turn
  // that fails afterwards only shows on the run thread.
  const failed =
    task.lastRunStatus === "failed" || (!working && runThread?.runtime?.status === "failed");
  const content = (
    <>
      <span className="flex h-5 min-w-0 items-center gap-1.5 text-sm">
        <span className="min-w-0 flex-1 truncate">
          {task.title}
          {machine ? <span className="text-secondary-label"> · {machine}</span> : null}
        </span>
        <span className="shrink-0 text-xs">
          {working ? (
            <span className="inline-flex items-center gap-1 font-medium text-info-foreground">
              <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
              Working
              <span aria-hidden>
                <WorkingDuration startedAt={resolveThreadWorkingStartedAt(runThread)} />
              </span>
            </span>
          ) : failed ? (
            <span className="inline-flex items-center gap-1 font-medium text-error-foreground">
              <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
              Failed
            </span>
          ) : (
            <span className="text-secondary-label">Idle</span>
          )}
        </span>
      </span>
      <span className="truncate text-secondary-label text-xs">
        Last {task.lastRunAt ? <LastRunLabel value={task.lastRunAt} /> : "never"}
        {" · "}
        {!task.enabled ? (
          "Paused"
        ) : task.schedule.type === "webhook" ? (
          "On webhook"
        ) : task.nextRunAt ? (
          <>
            Next <ScheduledRelativeLabel value={task.nextRunAt} />
          </>
        ) : (
          "Not scheduled"
        )}
      </span>
    </>
  );
  return (
    <li>
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
