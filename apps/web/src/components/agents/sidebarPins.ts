import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarAgentsSettings } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import type { KeyboardEvent, MouseEvent } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { useUpdatePrimarySettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { railsAgentHandle } from "./railsAgents";

const DEFAULT_PINNED_KEYS: ReadonlyArray<string> = ["cos"];
const LOCAL_PINNED_KEY = "t3code:sidebar-agents:pinned";
const LOCAL_HIDDEN_KEY = "t3code:sidebar-agents:hidden";
const readLocalKeys = (key: string) => {
  try {
    return getLocalStorageItem(key, Schema.Array(Schema.String));
  } catch {
    return null;
  }
};
const localPinnedKeys = readLocalKeys(LOCAL_PINNED_KEY);
const localHiddenKeys = readLocalKeys(LOCAL_HIDDEN_KEY);
const migrationWrites = new Set<string>();
let migrationComplete = false;
let stopMigration: (() => void) | null = null;

function watchMigrationWrite(updatedAt: string) {
  if (migrationComplete) return;
  migrationWrites.add(updatedAt);
  stopMigration ??= appAtomRegistry.subscribe(
    environmentPresentations.presentationsAtom,
    (presentations) => {
      if (
        ![...presentations.values()].some((presentation) => {
          const saved = presentation.serverConfig?.settings.sidebarAgents;
          return saved != null && migrationWrites.has(saved.updatedAt);
        })
      )
        return;
      try {
        removeLocalStorageItem(LOCAL_PINNED_KEY);
        removeLocalStorageItem(LOCAL_HIDDEN_KEY);
      } catch {
        return;
      }
      stopMigration?.();
      migrationWrites.clear();
      migrationComplete = true;
    },
  );
}

const pendingSidebarAgentsAtom = Atom.keepAlive(Atom.make<SidebarAgentsSettings | null>(null));

const sidebarAgentsAtom = Atom.make((get) => {
  const synced = [...get(environmentPresentations.presentationsAtom).entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .reduce<SidebarAgentsSettings | null>((current, [, presentation]) => {
      const entry = presentation.serverConfig?.settings.sidebarAgents ?? null;
      return entry !== null && (current === null || entry.updatedAt > current.updatedAt)
        ? entry
        : current;
    }, null);
  const pending = get(pendingSidebarAgentsAtom);
  return pending !== null && (synced === null || pending.updatedAt > synced.updatedAt)
    ? pending
    : synced;
}).pipe(Atom.withLabel("web-sidebar-agents"));

export function sidebarProjectPinKey(project: EnvironmentProject) {
  return (
    railsAgentHandle(project.workspaceRoot) ?? `project:${project.environmentId}:${project.id}`
  );
}

export function useSidebarPins() {
  const synced = useAtomValue(sidebarAgentsAtom);
  const updateSettings = useUpdatePrimarySettings();
  const pinnedFrom = (settings: SidebarAgentsSettings | null) =>
    settings?.pinned ?? localPinnedKeys ?? DEFAULT_PINNED_KEYS;
  const hiddenFrom = (settings: SidebarAgentsSettings | null) =>
    settings?.hidden ?? localHiddenKeys ?? [];
  const pinnedKeys = pinnedFrom(synced);
  const hiddenKeys = hiddenFrom(synced);
  const isPinned = (key: string) =>
    pinnedKeys.includes(key) || (!key.startsWith("project:") && !hiddenKeys.includes(key));
  const write = (change: Partial<Pick<SidebarAgentsSettings, "pinned" | "hidden" | "order">>) => {
    const current = appAtomRegistry.get(sidebarAgentsAtom);
    const next = {
      pinned: pinnedFrom(current),
      hidden: hiddenFrom(current),
      order: current?.order ?? [],
      ...change,
      updatedAt: new Date(
        Math.max(Date.now(), (Date.parse(current?.updatedAt ?? "") || 0) + 1),
      ).toISOString(),
    };
    appAtomRegistry.set(pendingSidebarAgentsAtom, next);
    watchMigrationWrite(next.updatedAt);
    updateSettings({ sidebarAgents: next });
  };
  const toggle = (key: string) => {
    const current = appAtomRegistry.get(sidebarAgentsAtom);
    const pinned = pinnedFrom(current);
    const hidden = hiddenFrom(current);
    const wasPinned =
      pinned.includes(key) || (!key.startsWith("project:") && !hidden.includes(key));
    write({
      pinned: wasPinned ? pinned.filter((entry) => entry !== key) : [...pinned, key],
      hidden: [...hidden.filter((entry) => entry !== key), ...(wasPinned ? [key] : [])],
    });
  };
  const setOrder = (handles: ReadonlyArray<string>) => write({ order: [...handles] });
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
  return {
    pinnedKeys,
    hiddenKeys,
    order: synced?.order ?? [],
    toggle,
    setOrder,
    showMenu,
    showProjectMenu,
  };
}
