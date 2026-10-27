import {
  type EnvironmentThreadShell,
  resolveThreadWorkingStartedAt,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon, CircleDashedIcon } from "lucide-react";

import { useAutomations } from "../../hooks/useAutomations";
import { useQuietThreadShells } from "../../state/entities";
import { ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";
import { WorkingDuration } from "../sidebar/WorkingDuration";

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

export function SidebarAutomationJobs({ onNavigate }: { readonly onNavigate: () => void }) {
  const automations = useAutomations();
  const threads = useQuietThreadShells();
  if (automations.length === 0) return null;
  return (
    <ul aria-label="Automation jobs" className="mb-2 flex flex-col pl-4">
      {automations.map(({ environmentId, task }) => (
        <AutomationJobRow
          key={`${environmentId}:${task.id}`}
          environmentId={environmentId}
          task={task}
          runThread={resolveRunThread(environmentId, task, threads)}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

function AutomationJobRow({
  environmentId,
  task,
  runThread,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
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
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
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
        Last {task.lastRunAt ? <ScheduledRelativeLabel value={task.lastRunAt} /> : "never"}
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
