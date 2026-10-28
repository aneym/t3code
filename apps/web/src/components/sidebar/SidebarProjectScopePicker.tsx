import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import {
  pinnedProjectGroups,
  projectGroupPinOrder,
} from "@t3tools/client-runtime/state/project-pins";
import { FolderIcon, ListFilterIcon, PinIcon, SettingsIcon } from "lucide-react";
import { useReducer, useRef, type RefObject } from "react";
import { useProjectPins } from "../../hooks/useProjectPins";
import { readLocalApi } from "../../localApi";
import {
  projectGroupsSpanEnvironments,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  filterSidebarProjectScopeItems,
  reduceSidebarProjectScopeMenuState,
} from "../Sidebar.logic";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import { SidebarPinnedProjectSwapper } from "./SidebarPinnedProjectSwapper";

export function SidebarProjectScopePicker({
  groups,
  scopeKey,
  scopedProject,
  setScopeKey,
  openSettings,
  anchor,
  primaryEnvironmentId,
  machines,
}: {
  groups: readonly SidebarProjectSnapshot[];
  scopeKey: string | null;
  scopedProject: SidebarProjectSnapshot | null;
  setScopeKey: (key: string | null) => void;
  openSettings: (project: SidebarProjectSnapshot) => void;
  anchor: RefObject<HTMLDivElement | null>;
  primaryEnvironmentId: EnvironmentId | null;
  machines: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
}) {
  const [menu, dispatch] = useReducer(reduceSidebarProjectScopeMenuState, {
    open: false,
    query: "",
  });
  const filter = useComboboxFilter();
  const highlighted = useRef<string | null>(null);
  const suppressSelection = useRef(false);
  const { canPin, togglePin, reorderPins } = useProjectPins(groups);
  const pinned = pinnedProjectGroups(groups);
  const ordered = [...pinned, ...groups.filter((group) => projectGroupPinOrder(group) === null)];
  const byKey = new Map(groups.map((group) => [group.projectKey, group]));
  const items = [
    { value: "all", label: "All projects" },
    ...ordered.map((group) => ({ value: group.projectKey, label: group.displayName })),
  ];
  const selected = items.find((item) => item.value === (scopeKey ?? "all")) ?? items[0]!;
  const filtered = filterSidebarProjectScopeItems({
    items,
    query: menu.query,
    matches: (item, query) => filter.contains(item, query, (candidate) => candidate.label),
  });
  const firstPinned = filtered.find((item) =>
    pinned.some((project) => project.projectKey === item.value),
  )?.value;
  const firstOther = filtered.find(
    (item) => item.value !== "all" && !pinned.some((project) => project.projectKey === item.value),
  )?.value;
  const showEnvironments = projectGroupsSpanEnvironments(groups);
  const settings = (project: SidebarProjectSnapshot) => {
    suppressSelection.current = true;
    dispatch({ type: "project-settings-opened" });
    openSettings(project);
  };
  const contextMenu = async (
    project: SidebarProjectSnapshot,
    position: { x: number; y: number },
  ) => {
    suppressSelection.current = true;
    const api = readLocalApi();
    if (!api) return;
    const action = await api.contextMenu.show(
      [
        {
          id: "pin",
          label: projectGroupPinOrder(project) === null ? "Pin project" : "Unpin project",
          disabled: !canPin(project),
        },
        { id: "settings", label: "Project settings", icon: "settings" },
      ],
      position,
    );
    if (action === "pin") await togglePin(project.projectKey);
    if (action === "settings") settings(project);
  };
  return (
    <>
      <SidebarPinnedProjectSwapper
        projects={pinned}
        scopeKey={scopeKey}
        setScopeKey={setScopeKey}
        reorder={reorderPins}
        canPin={canPin}
      />
      <Combobox
        items={items}
        filteredItems={filtered}
        autoHighlight
        itemToStringLabel={(item) => item.label}
        isItemEqualToValue={(a, b) => a.value === b.value}
        open={menu.open}
        onOpenChange={(open) => {
          if (open) suppressSelection.current = false;
          dispatch({ type: "open-changed", open });
        }}
        onItemHighlighted={(item) => {
          highlighted.current = item?.value ?? null;
        }}
        value={selected}
        onValueChange={(item) => {
          if (suppressSelection.current) {
            suppressSelection.current = false;
            return;
          }
          if (item) setScopeKey(item.value === "all" ? null : item.value);
        }}
      >
        <ComboboxTrigger
          render={
            <SidebarHeaderIconButton
              label={
                scopedProject
                  ? `Filter threads by project: ${scopedProject.displayName}`
                  : "Filter threads by project"
              }
            />
          }
        >
          {scopedProject ? (
            <span className="flex shrink-0">
              <ProjectFavicon project={scopedProject} className="size-4" />
            </span>
          ) : (
            <ListFilterIcon className="size-4" />
          )}
        </ComboboxTrigger>
        <ComboboxPopup
          align="start"
          anchor={anchor}
          className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
        >
          <ComboboxSearchInput
            aria-label="Search projects"
            placeholder="Search projects..."
            value={menu.query}
            onChange={(event) => dispatch({ type: "query-changed", query: event.target.value })}
            onKeyDown={(event) => {
              if (
                event.defaultPrevented ||
                event.nativeEvent.isComposing ||
                event.ctrlKey ||
                event.altKey ||
                event.metaKey ||
                (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
              )
                return;
              const project = highlighted.current ? byKey.get(highlighted.current) : null;
              if (project) {
                event.preventDefault();
                void contextMenu(project, {
                  x: event.currentTarget.getBoundingClientRect().left,
                  y: event.currentTarget.getBoundingClientRect().bottom,
                });
              }
            }}
          />
          <ComboboxEmpty>No matching projects.</ComboboxEmpty>
          <ComboboxList>
            {(item: (typeof items)[number]) => {
              const project = byKey.get(item.value) ?? null;
              const isPinned = project !== null && projectGroupPinOrder(project) !== null;
              return (
                <div key={item.value}>
                  {item.value === firstPinned ? (
                    <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                      Pinned
                    </div>
                  ) : null}
                  {item.value === firstOther && firstPinned ? (
                    <div role="separator" className="my-1 border-t border-border" />
                  ) : null}
                  <ComboboxItem
                    hideIndicator
                    value={item}
                    onContextMenu={(event) => {
                      if (project) {
                        event.preventDefault();
                        event.stopPropagation();
                        void contextMenu(project, { x: event.clientX, y: event.clientY });
                      }
                    }}
                  >
                    {project ? (
                      <ProjectFavicon project={project} className="size-4 shrink-0" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                    {project && showEnvironments ? (
                      <ProjectEnvironmentBadge
                        group={project}
                        primaryEnvironmentId={primaryEnvironmentId}
                        machineByEnvironmentId={machines}
                      />
                    ) : null}
                    {project ? (
                      <>
                        <span
                          className={
                            isPinned
                              ? "flex text-primary"
                              : "flex opacity-0 in-[[data-slot=combobox-item]:hover]:opacity-100 in-[[data-highlighted]]:opacity-100 has-[:focus-visible]:opacity-100"
                          }
                        >
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={`${isPinned ? "Unpin" : "Pin"} ${project.displayName}`}
                            tabIndex={-1}
                            disabled={!canPin(project)}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void togglePin(project.projectKey);
                            }}
                          >
                            <PinIcon
                              className={isPinned ? "size-3.5 text-primary" : "size-3.5"}
                              fill={isPinned ? "currentColor" : "none"}
                            />
                          </Button>
                        </span>
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          tabIndex={-1}
                          aria-hidden="true"
                          title={`Project settings for ${project.displayName}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            settings(project);
                          }}
                        >
                          <SettingsIcon className="size-3.5" />
                        </Button>
                      </>
                    ) : null}
                  </ComboboxItem>
                </div>
              );
            }}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </>
  );
}
