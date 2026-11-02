import { useProjectPin } from "../../hooks/useProjectGroupUpdate";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentId,
  EnvironmentMachineKind,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { pinnedProjectGroups } from "@t3tools/client-runtime/state/project-pins";
import { CheckIcon, FolderIcon, ListFilterIcon, PinIcon, SettingsIcon } from "lucide-react";
import { useReducer, useRef, type RefObject } from "react";
import { useProjectPinReorder } from "../../hooks/useProjectPinReorder";
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
import { AgentProjectIcon, useAgentProjectGroups } from "../agents/agentProjectPresentation";
import { Button } from "../ui/button";
import { isProjectPinShortcut } from "../ProjectPinButton";
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
  groups: projectGroups,
  scopeKeys,
  allSelected,
  scopedProjects: scopedGroups,
  setScopeKey,
  toggleScopeKey,
  keybindings,
  openSettings,
  anchor,
  primaryEnvironmentId,
  machines,
}: {
  groups: readonly SidebarProjectSnapshot[];
  scopeKeys: readonly string[];
  allSelected: boolean;
  scopedProjects: readonly SidebarProjectSnapshot[];
  setScopeKey: (key: string | null) => void;
  toggleScopeKey: (key: string) => void;
  keybindings: ResolvedKeybindingsConfig;
  openSettings: (project: SidebarProjectSnapshot) => void;
  anchor: RefObject<HTMLDivElement | null>;
  primaryEnvironmentId: EnvironmentId | null;
  machines: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
}) {
  const groups = useAgentProjectGroups(pickableProjectGroups(projectGroups));
  const byKey = new Map(groups.map((group) => [group.projectKey, group]));
  const scopedProjects = scopedGroups.map((group) => byKey.get(group.projectKey) ?? group);
  const [menu, dispatch] = useReducer(reduceSidebarProjectScopeMenuState, {
    open: false,
    query: "",
  });
  const filter = useComboboxFilter();
  const highlighted = useRef<string | null>(null);
  const suppressSelection = useRef(false);
  const { reorderPins } = useProjectPinReorder(groups);
  const { canPinProjectGroup: canPin, toggleProjectGroupPin } = useProjectPin();
  const pinned = pinnedProjectGroups(groups);
  const triggerProject =
    scopedProjects.find(
      (scoped) => !pinned.slice(0, 5).some((project) => project.projectKey === scoped.projectKey),
    ) ?? null;
  const ordered = [...pinned, ...groups.filter((group) => !group.pinned)];
  const folderNames = new Map(projectGroups.map((group) => [group.projectKey, group.displayName]));
  const items = [
    { value: "all", label: "All projects", searchLabels: ["All projects"] },
    ...ordered.map((group) => ({
      value: group.projectKey,
      label: group.displayName,
      searchLabels: [group.displayName, folderNames.get(group.projectKey) ?? group.displayName],
    })),
  ];
  const selected = allSelected
    ? items[0]!
    : scopeKeys.length === 1
      ? (items.find((item) => item.value === scopeKeys[0]) ?? null)
      : null;
  const filtered = filterSidebarProjectScopeItems({
    items,
    query: menu.query,
    matches: (item, query) =>
      item.searchLabels.some((searchLabel) => filter.contains(item, query, () => searchLabel)),
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
    const api = readLocalApi();
    if (!api) return;
    const action = await api.contextMenu.show(
      [
        {
          id: "pin",
          label: !project.pinned ? "Pin project" : "Unpin project",
          disabled: !canPin(project),
        },
        { id: "settings", label: "Project settings", icon: "settings" },
      ],
      position,
    );
    if (action === "pin") await toggleProjectGroupPin(project);
    if (action === "settings") settings(project);
  };
  return (
    <>
      <SidebarPinnedProjectSwapper
        projects={pinned}
        scopeKeys={scopeKeys}
        allSelected={allSelected}
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
        onOpenChange={(open, eventDetails) => {
          if (eventDetails.isCanceled) return;
          if (open) suppressSelection.current = false;
          dispatch({ type: "open-changed", open });
        }}
        onItemHighlighted={(item) => {
          highlighted.current = item?.value ?? null;
        }}
        value={selected}
        onValueChange={(item, eventDetails) => {
          if (suppressSelection.current) {
            suppressSelection.current = false;
            return;
          }
          if (!item) return;
          if (item.value === "all") setScopeKey(null);
          else if (eventDetails.event instanceof MouseEvent && eventDetails.event.shiftKey) {
            eventDetails.cancel();
            toggleScopeKey(item.value);
          } else setScopeKey(item.value);
        }}
      >
        <ComboboxTrigger
          render={
            <SidebarHeaderIconButton
              label={
                scopedProjects.length > 0
                  ? `Filter threads by project: ${scopedProjects.map((project) => project.displayName).join(", ")}`
                  : "Filter threads by project"
              }
            />
          }
        >
          {triggerProject ? (
            <span className="flex shrink-0">
              <AgentProjectIcon project={triggerProject} className="size-4" />
            </span>
          ) : (
            <ListFilterIcon className="size-4" />
          )}
        </ComboboxTrigger>
        <ComboboxPopup
          align="start"
          anchor={anchor}
          className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
          finalFocus={(closeType) => closeType === "keyboard"}
        >
          <ComboboxSearchInput
            aria-label="Search projects"
            placeholder="Search projects..."
            value={menu.query}
            onChange={(event) => dispatch({ type: "query-changed", query: event.target.value })}
            onKeyDown={(event) => {
              if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229)
                return;
              const project = highlighted.current ? byKey.get(highlighted.current) : null;
              if (project && canPin(project) && isProjectPinShortcut(event, keybindings)) {
                event.preventDefault();
                event.stopPropagation();
                void toggleProjectGroupPin(project);
                return;
              }
              if (event.ctrlKey || event.altKey || event.metaKey) return;
              if (event.shiftKey && event.key === "Enter") {
                if (!project) return;
                event.preventDefault();
                toggleScopeKey(project.projectKey);
                return;
              }
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
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
          <ComboboxList aria-multiselectable>
            {(item: (typeof items)[number]) => {
              const project = byKey.get(item.value) ?? null;
              const isPinned = project !== null && project.pinned;
              const isSelected = project ? scopeKeys.includes(item.value) : allSelected;
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
                    aria-selected={isSelected}
                    data-selected={undefined}
                    onContextMenu={(event) => {
                      if (project) {
                        event.preventDefault();
                        event.stopPropagation();
                        void contextMenu(project, { x: event.clientX, y: event.clientY });
                      }
                    }}
                  >
                    <span className="relative flex shrink-0">
                      {project ? (
                        <AgentProjectIcon project={project} className="size-4 shrink-0" />
                      ) : (
                        <FolderIcon className="size-4 shrink-0" />
                      )}
                      {isSelected ? (
                        <span className="pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-primary ring-2 ring-popover">
                          <CheckIcon
                            className="size-2 text-primary-foreground"
                            strokeWidth={4}
                            aria-hidden
                          />
                        </span>
                      ) : null}
                    </span>
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
                              void toggleProjectGroupPin(project);
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
