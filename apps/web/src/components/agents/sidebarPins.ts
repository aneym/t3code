import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import type { KeyboardEvent, MouseEvent } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { readLocalApi } from "../../localApi";
import { railsAgentHandle } from "./railsAgents";

const PINNED_KEY = "t3code:sidebar-agents:pinned";
const PinnedKeys = Schema.Array(Schema.String);
const DEFAULT_PINNED_KEYS: ReadonlyArray<string> = ["cos"];
const HIDDEN_KEY = "t3code:sidebar-agents:hidden";
const DEFAULT_HIDDEN_KEYS: ReadonlyArray<string> = [];

export function sidebarProjectPinKey(project: EnvironmentProject) {
  return (
    railsAgentHandle(project.workspaceRoot) ?? `project:${project.environmentId}:${project.id}`
  );
}

export function useSidebarPins() {
  const [pinnedKeys, setPinnedKeys] = useLocalStorage(PINNED_KEY, DEFAULT_PINNED_KEYS, PinnedKeys);
  const [hiddenKeys, setHiddenKeys] = useLocalStorage(HIDDEN_KEY, DEFAULT_HIDDEN_KEYS, PinnedKeys);
  const isPinned = (key: string) =>
    pinnedKeys.includes(key) || (!key.startsWith("project:") && !hiddenKeys.includes(key));
  const toggle = (key: string) => {
    const pinned = isPinned(key);
    setPinnedKeys((keys) => (pinned ? keys.filter((entry) => entry !== key) : [...keys, key]));
    setHiddenKeys((keys) => [...keys.filter((entry) => entry !== key), ...(pinned ? [key] : [])]);
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
        { id: "toggle-pin", label: `${isPinned(key) ? "Unpin" : "Pin"} ${name}` },
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
  return { pinnedKeys, hiddenKeys, toggle, showMenu, showProjectMenu };
}
