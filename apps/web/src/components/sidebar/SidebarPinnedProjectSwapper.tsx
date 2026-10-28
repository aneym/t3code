import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, LayoutGridIcon, MoreHorizontalIcon } from "lucide-react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";

const chipClass =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-sm opacity-55 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-popover aria-pressed:opacity-100 aria-pressed:shadow-sm aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-border";

type PinnedProjectControls = {
  projects: readonly SidebarProjectSnapshot[];
  scopeKey: string | null;
  setScopeKey: (key: string | null) => void;
  reorder: (active: string, over: string) => Promise<void>;
  canPin: (project: SidebarProjectSnapshot) => boolean;
};

function PinnedProjectChip({
  project,
  selected,
  onSelect,
  disabled,
}: {
  project: SidebarProjectSnapshot;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.projectKey,
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("group/pin relative", isDragging && "z-10")}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={project.displayName}
              aria-pressed={selected}
              className={chipClass}
              style={{ borderRadius: 5 }}
              onClick={onSelect}
            />
          }
        >
          <ProjectFavicon project={project} className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>{project.displayName}</TooltipPopup>
      </Tooltip>
      <button
        type="button"
        aria-label={`Reorder ${project.displayName}`}
        disabled={disabled}
        className="absolute -bottom-1 left-1/2 flex h-2 w-4 -translate-x-1/2 touch-none items-center justify-center rounded bg-muted opacity-0 group-hover/pin:opacity-100 focus-visible:opacity-100"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-2.5" />
      </button>
    </div>
  );
}

function SortablePinnedProjectChips({
  projects,
  scopeKey,
  setScopeKey,
  reorder,
  canPin,
  expanded = false,
}: PinnedProjectControls & { expanded?: boolean }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id) void reorder(String(active.id), String(over.id));
      }}
    >
      <SortableContext
        items={projects.map((project) => project.projectKey)}
        strategy={expanded ? rectSortingStrategy : horizontalListSortingStrategy}
      >
        <div className={cn("flex items-center gap-0.5", expanded ? "flex-wrap gap-2" : "shrink-0")}>
          {projects.map((project) => (
            <PinnedProjectChip
              key={project.projectKey}
              project={project}
              selected={scopeKey === project.projectKey}
              onSelect={() =>
                setScopeKey(scopeKey === project.projectKey ? null : project.projectKey)
              }
              disabled={!canPin(project)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

export function SidebarPinnedProjectSwapper(props: PinnedProjectControls) {
  const { projects, scopeKey, setScopeKey } = props;
  if (projects.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Pinned projects"
      data-pinned-projects
      style={{ borderRadius: 7 }}
      className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto rounded-md bg-muted p-0.5"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="All projects"
              aria-pressed={scopeKey === null}
              className={chipClass}
              style={{ borderRadius: 5 }}
              onClick={() => setScopeKey(null)}
            />
          }
        >
          <LayoutGridIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>All projects</TooltipPopup>
      </Tooltip>
      <SortablePinnedProjectChips {...props} projects={projects.slice(0, 5)} />
      {projects.length > 5 ? (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Show and reorder all pinned projects"
                className={chipClass}
              />
            }
          >
            <MoreHorizontalIcon className="size-3.5" />
          </PopoverTrigger>
          <PopoverPopup align="start" padding="compact" width="sm">
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                Drag the handles to reorder pinned projects
              </div>
              <div
                role="toolbar"
                aria-label="All pinned projects"
                className="max-h-64 overflow-y-auto pb-1"
              >
                <SortablePinnedProjectChips {...props} expanded />
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
