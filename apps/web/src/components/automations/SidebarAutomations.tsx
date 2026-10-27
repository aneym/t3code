import { Link } from "@tanstack/react-router";
import { CalendarClockIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { type EnvironmentAutomation, useAutomations } from "../../hooks/useAutomations";
import { useQuietThreadShells } from "../../state/entities";
import { AutomationStatusLabel } from "./AutomationStatusLabel";
import { resolveAutomationRunThread, resolveAutomationStatus } from "./automationStatus";

const SETTINGS_SEARCH = { machine: undefined, project: undefined, checkout: undefined };
const ROW_CLASS =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SidebarAutomations({ onNavigate }: { readonly onNavigate: () => void }) {
  const automations = useAutomations();
  return (
    <nav aria-label="Automations" className="mb-2">
      <Link
        to="/settings/scheduled-tasks"
        search={SETTINGS_SEARCH}
        className={cn(ROW_CLASS, "py-2 text-muted-foreground")}
        onClick={onNavigate}
      >
        <CalendarClockIcon className="size-4" />
        Automations
      </Link>
      {automations.length > 0 ? (
        <SidebarAutomationList automations={automations} onNavigate={onNavigate} />
      ) : null}
    </nav>
  );
}

function SidebarAutomationList({
  automations,
  onNavigate,
}: {
  readonly automations: ReadonlyArray<EnvironmentAutomation>;
  readonly onNavigate: () => void;
}) {
  const threads = useQuietThreadShells();
  return (
    <ul className="pl-4">
      {automations.map(({ environmentId, task }) => {
        const runThread = resolveAutomationRunThread(environmentId, task, threads);
        const status = resolveAutomationStatus(task, runThread);
        const content = (
          <>
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            <span className="shrink-0 text-xs">
              <AutomationStatusLabel status={status} />
            </span>
          </>
        );
        return (
          <li
            key={`${environmentId}:${task.id}`}
            title={status.kind === "failed" ? (status.error ?? undefined) : undefined}
          >
            {runThread === null ? (
              <Link
                to="/settings/scheduled-tasks"
                search={SETTINGS_SEARCH}
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
      })}
    </ul>
  );
}
