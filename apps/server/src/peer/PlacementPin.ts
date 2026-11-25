import type { AgentPlacementScore, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { pinAllowed } from "./PlacementSpill.ts";

export const pinnedPlacement = (input: {
  readonly here: EnvironmentId;
  readonly namedProjectId: ProjectId | undefined;
  readonly projectId: ProjectId | undefined;
  readonly matching: ReadonlyMap<EnvironmentId, ProjectId>;
  readonly scores: ReadonlyArray<AgentPlacementScore>;
  readonly hereWeight: number;
  readonly settingsPin: EnvironmentId | null;
  readonly atStart: boolean;
  readonly spill: boolean;
}) => {
  const { here, matching } = input;
  const projectElsewhere = [...matching].some(
    ([environmentId, mapped]) => environmentId !== here && mapped === input.projectId,
  );
  if (
    !input.spill &&
    !input.atStart &&
    input.namedProjectId !== undefined &&
    matching.has(here) &&
    input.hereWeight > 0 &&
    !projectElsewhere
  )
    return { environmentId: here, reason: "Pinned by project." };
  const pinned = input.settingsPin;
  if (
    pinned !== null &&
    matching.has(pinned) &&
    pinAllowed(input.scores, pinned, here, input.spill)
  )
    return { environmentId: pinned, reason: "Pinned to this environment in settings." };
  return undefined;
};
