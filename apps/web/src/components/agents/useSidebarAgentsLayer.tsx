import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  ResolvedKeybindingsConfig,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { SidebarAgents } from "./SidebarAgents";
import { agentScopeProjectKeys, useAgentFocusHandle, useSidebarAgentThreads } from "./agentFocus";
import { useAgentMainThreadMenu } from "./agentMainThreadMenu";
import {
  openSidebarJumpAgent,
  sidebarJumpKeys,
  sidebarJumpLabels,
  useSidebarAgentLists,
} from "./sidebarAgentLists";

export function useSidebarAgentsLayer({
  threads,
  projectGroups,
  keybindings,
  onNavigate,
}: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onNavigate: () => void;
}) {
  const [, setFocus] = useAgentFocusHandle();
  const work = useSidebarAgentThreads(threads, projectGroups);
  const focused = work.projectKeys !== null;
  const lists = useSidebarAgentLists(null);
  const menu = useAgentMainThreadMenu();
  return {
    threads: work.threads,
    scopeKeys: work.scopeKeys,
    focused,
    clearFocus: () => setFocus(null),
    scopeProjectKeys: agentScopeProjectKeys,
    scopedProjectKeys: (keys: ReadonlySet<string> | null) => (focused ? null : keys),
    settledScopeKeys: (keys: ReadonlySet<string> | null) => work.projectKeys ?? keys,
    folders: (groups: ReadonlyArray<SidebarProjectSnapshot>, enabled: boolean) => ({
      folderGroups: enabled ? (groups.length === 0 || focused ? projectGroups : groups) : null,
      keepEmptyFolders: groups.length > 0 && !focused,
    }),
    projectGroups,
    jumpKeys: (keys: ReadonlyArray<string>) => sidebarJumpKeys(lists.jumpable, keys),
    jumpLabels: (keys: ReadonlyArray<string>) => sidebarJumpLabels(keys, keybindings),
    openJump: (
      key: string | null,
      navigate: (ref: ScopedThreadRef) => unknown,
      start: (ref: ScopedProjectRef) => unknown,
    ) => openSidebarJumpAgent(lists.jumpable, key, navigate, start),
    contextMenu: {
      options: menu.options,
      handle: (value: string, thread: EnvironmentThreadShell) => {
        if (!value.startsWith("agent-main:")) return false;
        void menu.assign(value.slice("agent-main:".length), thread);
        return true;
      },
    },
    element: ({
      projectKeys,
      jumpLabelByKey,
      setProjectScope,
    }: {
      readonly projectKeys: ReadonlySet<string> | null;
      readonly jumpLabelByKey: ReadonlyMap<string, string> | null;
      readonly setProjectScope: (keys: readonly string[]) => void;
    }) => (
      <SidebarAgents
        onNavigate={onNavigate}
        pinned={lists.pinned}
        hidden={lists.hidden.filter(
          (agent) =>
            projectKeys === null ||
            (agent.projectRef !== null &&
              projectKeys.has(`${agent.projectRef.environmentId}:${agent.projectRef.projectId}`)),
        )}
        jumpLabelByKey={jumpLabelByKey}
        setProjectScope={setProjectScope}
      />
    ),
  };
}
