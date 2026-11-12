import type { OrchestrationV2AppThread, ServerSettings } from "@t3tools/contracts";

export interface ResolvedAgentToolProfile {
  readonly tools: ReadonlyArray<string>;
  readonly guidance: string;
}

export const resolveThreadAgentToolProfile = (
  settings: Pick<ServerSettings, "agentToolProfiles" | "projectAgentToolProfiles">,
  thread: Pick<OrchestrationV2AppThread, "projectId" | "worktreePath">,
): ResolvedAgentToolProfile | undefined => {
  if (thread.worktreePath !== null) return undefined;
  const name = settings.projectAgentToolProfiles[thread.projectId];
  return name === undefined ? undefined : settings.agentToolProfiles[name];
};

export const matchesAgentToolProfile = (
  current: {
    readonly toolAllowlist: ReadonlySet<string> | undefined;
    readonly toolGuidance: string | undefined;
  },
  profile: ResolvedAgentToolProfile | undefined,
): boolean =>
  profile === undefined
    ? current.toolAllowlist === undefined && current.toolGuidance === undefined
    : current.toolGuidance === profile.guidance &&
      current.toolAllowlist !== undefined &&
      current.toolAllowlist.size === new Set(profile.tools).size &&
      profile.tools.every((tool) => current.toolAllowlist?.has(tool) === true);
