import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarAgentsSettings } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import type { KeyboardEvent, MouseEvent } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

import { getLocalStorageItem } from "../../hooks/useLocalStorage";
import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { railsAgentHandle } from "./railsAgents";

const DEFAULT_PINNED_KEYS: ReadonlyArray<string> = ["cos"];
const LOCAL_PINNED_KEY = "t3code:sidebar-agents:pinned";

const newer = (current: SidebarAgentsSettings | null, entry: SidebarAgentsSettings | null) =>
  entry !== null && (current === null || entry.updatedAt > current.updatedAt) ? entry : current;

const pendingSidebarAgentsAtom = Atom.keepAlive(Atom.make<SidebarAgentsSettings | null>(null));

const sidebarAgentsAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom).entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .reduce(
      (current, [, presentation]) =>
        newer(current, presentation.serverConfig?.settings.sidebarAgents ?? null),
      get(pendingSidebarAgentsAtom),
    ),
).pipe(Atom.withLabel("web-sidebar-agents"));

export function sidebarProjectPinKey(project: EnvironmentProject) {
  return (
    railsAgentHandle(project.workspaceRoot) ?? `project:${project.environmentId}:${project.id}`
  );
}

export function useSidebarPins() {
  const synced = useAtomValue(sidebarAgentsAtom);
  const updateSettings = useUpdatePrimarySettings();
  const pinnedFrom = (settings: SidebarAgentsSettings | null) =>
    settings?.pinned ??
    getLocalStorageItem(LOCAL_PINNED_KEY, Schema.Array(Schema.String)) ??
    DEFAULT_PINNED_KEYS;
  const pinnedKeys = pinnedFrom(synced);
  const toggle = (key: string) => {
    const current = appAtomRegistry.get(sidebarAgentsAtom);
    const pinned = pinnedFrom(current);
    const next = {
      pinned: pinned.includes(key) ? pinned.filter((entry) => entry !== key) : [...pinned, key],
      hidden: current?.hidden ?? [],
      updatedAt: new Date().toISOString(),
    };
    appAtomRegistry.set(pendingSidebarAgentsAtom, next);
    updateSettings({ sidebarAgents: next });
  };
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
