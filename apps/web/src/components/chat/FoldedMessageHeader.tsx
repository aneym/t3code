import type { EnvironmentId, ScheduledTaskId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { ChevronDownIcon, type LucideIcon } from "lucide-react";
import { cn } from "~/lib/utils";

export function FoldedMessageHeader(props: {
  icon: LucideIcon;
  label: string;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      data-scroll-anchor-ignore
      onClick={props.onToggle}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-2xl px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Icon className="size-4 shrink-0 stroke-2 text-muted-foreground" />
      <span className="max-w-1/2 shrink-0 truncate text-muted-foreground">{props.label}</span>
      <span className="min-w-0 flex-1 truncate">{props.summary}</span>
      <ChevronDownIcon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          props.expanded && "rotate-180",
        )}
      />
    </button>
  );
}

export function useScheduledTaskTitle(
  environmentId: EnvironmentId,
  scheduledTaskId: ScheduledTaskId | undefined,
): string | undefined {
  const tasksQuery = useEnvironmentQuery(
    scheduledTaskId ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  return tasksQuery.data?.tasks.find((task) => task.id === scheduledTaskId)?.title;
}
