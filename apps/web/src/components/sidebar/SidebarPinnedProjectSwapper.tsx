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
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, LayoutGridIcon } from "lucide-react";
import { useRef } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";

const chipClass =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-sm opacity-55 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-popover aria-pressed:opacity-100 aria-pressed:shadow-sm aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-border";

function PinnedProjectChip({
  project,
  selected,
  onSelect,
  disabled,
  suppressClick,
}: {
  project: SidebarProjectSnapshot;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
  suppressClick: () => boolean;
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
              onClick={() => {
                if (!suppressClick()) onSelect();
              }}
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

export function SidebarPinnedProjectSwapper({
  projects,
  scopeKey,
  setScopeKey,
  reorder,
  canPin,
}: {
  projects: readonly SidebarProjectSnapshot[];
  scopeKey: string | null;
  setScopeKey: (key: string | null) => void;
  reorder: (active: string, over: string) => Promise<void>;
  canPin: (project: SidebarProjectSnapshot) => boolean;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const dragged = useRef(false);
  if (projects.length === 0) return null;
  const visible = projects.slice(0, 5);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={() => {
        dragged.current = true;
      }}
      onDragCancel={() => {
        dragged.current = false;
      }}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id) void reorder(String(active.id), String(over.id));
        dragged.current = false;
      }}
    >
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
        <SortableContext
          items={visible.map((project) => project.projectKey)}
          strategy={horizontalListSortingStrategy}
        >
          {visible.map((project) => (
            <PinnedProjectChip
              key={project.projectKey}
              project={project}
              selected={scopeKey === project.projectKey}
              onSelect={() =>
                setScopeKey(scopeKey === project.projectKey ? null : project.projectKey)
              }
              disabled={!canPin(project)}
              suppressClick={() => dragged.current}
            />
          ))}
        </SortableContext>
      </div>
    </DndContext>
  );
}
