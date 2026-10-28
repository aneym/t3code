import { Link } from "@tanstack/react-router";
import { CalendarClockIcon } from "lucide-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentAutomation } from "../../hooks/useAutomations";

export function automationThreadsWithoutJobs(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  automations: ReadonlyArray<EnvironmentAutomation>,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads.filter(
    (thread) =>
      thread.automationTaskId != null &&
      thread.archivedAt === null &&
      !automations.some(
        ({ environmentId, task }) =>
          environmentId === thread.environmentId &&
          (task.threadId === thread.id || task.id === thread.automationTaskId),
      ),
  );
}

export function AutomationThreadRows({
  threads,
  onNavigate,
}: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onNavigate: () => void;
}) {
  return threads.map((thread) => (
    <li key={`${thread.environmentId}:${thread.id}`} className="list-none">
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: thread.environmentId, threadId: thread.id }}
        onClick={onNavigate}
        className="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <CalendarClockIcon aria-hidden className="size-4 shrink-0 opacity-40" />
        <span className="truncate">{thread.title}</span>
      </Link>
    </li>
  ));
}
