import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { AgentFace } from "./AgentFace";
import { type RailsAgent, useRailsAgents } from "./railsAgents";

export interface AgentProjectSnapshot extends SidebarProjectSnapshot {
  readonly agent?: RailsAgent;
}

export function useAgentProjectGroups(
  groups: readonly SidebarProjectSnapshot[],
): readonly AgentProjectSnapshot[] {
  const agents = useRailsAgents();
  const byHome = new Map(
    agents.flatMap((agent) =>
      agent.homeProjectRefs.map((ref) => [scopedProjectKey(ref), agent] as const),
    ),
  );
  return groups.map((group) => {
    const owners = group.memberProjectRefs.map((ref) => byHome.get(scopedProjectKey(ref)));
    const agent = owners[0];
    if (!agent || owners.some((owner) => owner !== agent)) return group;
    return { ...group, displayName: agent.name, agent };
  });
}

export function AgentProjectIcon({
  project,
  className,
}: {
  readonly project: AgentProjectSnapshot;
  readonly className?: string;
}) {
  return project.agent ? (
    <span className={cn("inline-flex size-4 shrink-0 [&>*]:size-full", className)}>
      <AgentFace key={project.agent.handle} agent={project.agent} />
    </span>
  ) : (
    <ProjectFavicon project={project} className={className} />
  );
}
