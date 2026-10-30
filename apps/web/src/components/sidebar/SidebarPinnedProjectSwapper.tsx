import { DndContext, KeyboardSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LayoutGridIcon, MoreHorizontalIcon } from "lucide-react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { SidebarPointerSensor } from "../Sidebar.pointer";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";

const chipClass =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-sm opacity-55 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-popover aria-pressed:opacity-100 aria-pressed:shadow-sm aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-border";

const pointerSensorOptions = { distance: 6, onAttach: () => {}, onFinish: () => {} };
const keyboardSensorOptions = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
};

type PinnedProjectControls = {
  projects: readonly SidebarProjectSnapshot[];
  scopeKeys: readonly string[];
  allSelected: boolean;
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
      className={cn("relative", isDragging && "z-10")}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              {...(disabled ? {} : attributes)}
              {...listeners}
              aria-label={project.displayName}
              aria-pressed={selected}
              className={cn(chipClass, "touch-none")}
              style={{ borderRadius: 5 }}
              onClick={onSelect}
            />
          }
        >
          <ProjectFavicon project={project} className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>{project.displayName}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function SortablePinnedProjectChips({
  projects,
  scopeKeys,
  setScopeKey,
  reorder,
  canPin,
  expanded = false,
}: PinnedProjectControls & { expanded?: boolean }) {
  const sensors = useSensors(
    useSensor(SidebarPointerSensor, pointerSensorOptions),
    useSensor(KeyboardSensor, keyboardSensorOptions),
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
        strategy={rectSortingStrategy}
      >
        <div className={expanded ? "flex flex-wrap gap-2" : "contents"}>
          {projects.map((project) => (
            <PinnedProjectChip
              key={project.projectKey}
              project={project}
              selected={scopeKeys.includes(project.projectKey)}
              onSelect={() =>
                setScopeKey(
                  scopeKeys.length === 1 && scopeKeys[0] === project.projectKey
                    ? null
                    : project.projectKey,
                )
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
  const { projects, allSelected, setScopeKey } = props;
  if (projects.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Pinned projects"
      data-pinned-projects
      style={{ borderRadius: 7 }}
      className="flex min-w-0 shrink flex-wrap items-center gap-0.5 rounded-md bg-muted p-0.5"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="All projects"
              aria-pressed={allSelected}
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
                Drag to reorder pinned projects
              </div>
              <div role="toolbar" aria-label="All pinned projects">
                <SortablePinnedProjectChips {...props} expanded />
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
