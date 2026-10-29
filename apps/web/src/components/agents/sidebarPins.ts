import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarAgentsSettings } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { KeyboardEvent, MouseEvent } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { environmentPresentations } from "../../state/presentation";
import { railsAgentHandle } from "./railsAgents";

const DEFAULT_PINNED_KEYS: ReadonlyArray<string> = ["cos"];

const sidebarAgentsAtom = Atom.make((get) =>
  [
    ...get(environmentPresentations.presentationsAtom).values(),
  ].reduce<SidebarAgentsSettings | null>((newest, presentation) => {
    const entry = presentation.serverConfig?.settings.sidebarAgents ?? null;
    return entry !== null && (newest === null || entry.updatedAt > newest.updatedAt)
      ? entry
      : newest;
  }, null),
).pipe(Atom.withLabel("web-sidebar-agents"));

export function sidebarProjectPinKey(project: EnvironmentProject) {
  return (
    railsAgentHandle(project.workspaceRoot) ?? `project:${project.environmentId}:${project.id}`
  );
}

export function useSidebarPins() {
  const synced = useAtomValue(sidebarAgentsAtom);
  const updateSettings = useUpdatePrimarySettings();
  const pinnedKeys = synced?.pinned ?? DEFAULT_PINNED_KEYS;
  const toggle = (key: string) =>
    updateSettings({
      sidebarAgents: {
        pinned: pinnedKeys.includes(key)
          ? pinnedKeys.filter((entry) => entry !== key)
          : [...pinnedKeys, key],
        hidden: synced?.hidden ?? [],
        updatedAt: new Date().toISOString(),
      },
    });
  const showMenu = async (
    key: string,
    name: string,
    position: { x: number; y: number },
    projectSettings = false,
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const selected = await api.contextMenu.show(
      [
        { id: "toggle-pin", label: `${pinnedKeys.includes(key) ? "Unpin" : "Pin"} ${name}` },
        ...(projectSettings ? [{ id: "project-settings", label: "Project settings" }] : []),
      ],
      position,
    );
    if (selected === "toggle-pin") toggle(key);
    return selected;
  };
  const showProjectMenu = async (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLInputElement>,
    group: SidebarProjectSnapshot,
    projects: ReadonlyMap<string, EnvironmentProject>,
    openSettings: (group: SidebarProjectSnapshot) => void,
  ) => {
    if (event.type === "click") {
      openSettings(group);
      return;
    }
    const ref = group.memberProjectRefs[0];
    const project = ref ? projects.get(`${ref.environmentId}:${ref.projectId}`) : undefined;
    if (!project) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const selected = await showMenu(
      sidebarProjectPinKey(project),
      group.displayName,
      {
        x: "clientX" in event ? event.clientX : rect.left,
        y: "clientY" in event ? event.clientY : rect.bottom,
      },
      true,
    );
    if (selected === "project-settings") openSettings(group);
  };
  return { pinnedKeys, toggle, showMenu, showProjectMenu };
}
