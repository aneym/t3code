import { foldSearchQuery } from "@t3tools/shared/paletteSearch";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useEnvironmentIdentities } from "../../state/environments";
import type { CommandPaletteActionItem, CommandPaletteGroup } from "../CommandPalette.logic";
import { AgentFace } from "./AgentFace";
import { type RailsAgent, railsAgentThreadKey, useRailsAgents } from "./railsAgents";

const AGENT_GROUP = "agents-search";

function agentMatches(agent: RailsAgent, query: string): boolean {
  return [agent.name, agent.handle].some((name) => {
    const folded = foldSearchQuery(name);
    return (
      folded.startsWith(query) || folded.split(/[^a-z0-9]+/u).some((word) => word.startsWith(query))
    );
  });
}

export function useCommandPaletteAgentThreads(
  threadItems: ReadonlyArray<CommandPaletteActionItem>,
) {
  const agents = useRailsAgents();
  const handleNewThread = useNewThreadHandler();
  const labelById = new Map(
    useEnvironmentIdentities().map((environment) => [environment.environmentId, environment.label]),
  );
  const threadItemByValue = new Map(threadItems.map((item) => [item.value, item]));

  const agentItem = (agent: RailsAgent): CommandPaletteActionItem => {
    const environmentLabel = labelById.get(agent.projectRef.environmentId);
    const base = {
      value: `agent:${agent.handle}`,
      searchTerms: [agent.name, agent.handle],
      title: agent.name,
      icon: <AgentFace handle={agent.handle} name={agent.name} />,
      description: environmentLabel ? `Main thread · ${environmentLabel}` : "Main thread",
    };
    const threadItem =
      agent.thread === null
        ? undefined
        : threadItemByValue.get(`thread:${railsAgentThreadKey(agent.thread)}`);
    if (threadItem === undefined) {
      return {
        ...base,
        kind: "action",
        run: async () => {
          await handleNewThread(agent.projectRef);
        },
      };
    }
    const {
      threadSearch: _threadSearch,
      threadContentMatch: _threadContentMatch,
      matchHint: _matchHint,
      searchTitle: _searchTitle,
      timestamp: _timestamp,
      ...rest
    } = threadItem;
    return { ...rest, ...base, value: threadItem.value };
  };

  return (
    groups: ReadonlyArray<CommandPaletteGroup>,
    query: string,
    isInSubmenu: boolean,
  ): CommandPaletteGroup[] => {
    const folded = foldSearchQuery(query);
    if (isInSubmenu || query.startsWith(">") || folded.length === 0) return [...groups];
    const items = agents
      .filter((agent) => agentMatches(agent, folded))
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(agentItem);
    if (items.length === 0) return [...groups];
    const shown = new Set(items.map((item) => item.value));
    const rest = groups.flatMap((group) => {
      const remaining = group.items.filter((item) => !shown.has(item.value));
      return remaining.length === 0 ? [] : [{ ...group, items: remaining }];
    });
    return [{ value: AGENT_GROUP, label: "Agents", items }, ...rest];
  };
}
