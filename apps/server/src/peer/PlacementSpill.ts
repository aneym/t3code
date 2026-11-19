import type { AgentPlacementRoom, AgentPlacementScore, EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { AGENT_HOME_KEY_PREFIX, agentHomeKeyOfRoot } from "../agents/AgentHomeOfPath.ts";
import type * as Identities from "../project/RepositoryIdentityResolver.ts";
import { repositoryIdentityKeys } from "../project/RepositoryIdentityKeys.ts";

export class SpillLaunch extends Context.Service<SpillLaunch, { readonly startOrRefuse: true }>()(
  "t3/peer/PlacementSpill/SpillLaunch",
) {}

export const placementKeys = Effect.fn("PlacementSpill.placementKeys")(function* (
  identities: Identities.RepositoryIdentityResolver["Service"],
  workspaceRoot: string | undefined,
  repository: string | undefined,
  spill: boolean,
) {
  if (repository !== undefined)
    return repository.startsWith(AGENT_HOME_KEY_PREFIX) ? [] : [repository];
  if (workspaceRoot === undefined) return [];
  const keys = repositoryIdentityKeys(yield* identities.resolve(workspaceRoot));
  if (keys.length > 0 || !spill) return keys;
  const home = yield* Effect.promise(() => agentHomeKeyOfRoot(workspaceRoot));
  return home === undefined ? keys : [home];
});

export const spillSkip = (
  room: AgentPlacementRoom | undefined,
  environmentId: EnvironmentId,
  refused: ReadonlyArray<EnvironmentId> | undefined,
) =>
  refused?.includes(environmentId) === true
    ? "Refused the start: no room there."
    : room === undefined
      ? "No builder room reported there."
      : room.paused !== undefined
        ? `Paused: ${room.paused}`
        : (room.breach ?? (room.free === 0 ? "No free builder slot there." : undefined));

const eligible = (
  scores: ReadonlyArray<AgentPlacementScore>,
  here: EnvironmentId,
  spill: boolean,
) =>
  scores
    .filter(
      (entry) =>
        entry.skipped === undefined && entry.score > 0 && !(spill && entry.environmentId === here),
    )
    .toSorted((left, right) => right.score - left.score);

export const pickWinner = (
  scores: ReadonlyArray<AgentPlacementScore>,
  here: EnvironmentId,
  spill: boolean,
) => eligible(scores, here, spill)[0];

export const pinAllowed = (
  scores: ReadonlyArray<AgentPlacementScore>,
  pinned: EnvironmentId,
  here: EnvironmentId,
  spill: boolean,
) => !spill || eligible(scores, here, true).some((entry) => entry.environmentId === pinned);
