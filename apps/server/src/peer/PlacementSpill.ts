import type { AgentPlacementScore, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { agentHomeKeyOfRoot } from "../agents/AgentHomeOfPath.ts";
import type * as Identities from "../project/RepositoryIdentityResolver.ts";
import { repositoryIdentityKeys } from "../project/RepositoryIdentityKeys.ts";

export const placementKeys = Effect.fn("PlacementSpill.placementKeys")(function* (
  identities: Identities.RepositoryIdentityResolver["Service"],
  workspaceRoot: string | undefined,
  repository: string | undefined,
  spill: boolean,
) {
  if (repository !== undefined) return [repository];
  if (workspaceRoot === undefined) return [];
  const keys = repositoryIdentityKeys(yield* identities.resolve(workspaceRoot));
  if (keys.length > 0 || !spill) return keys;
  const home = yield* Effect.promise(() => agentHomeKeyOfRoot(workspaceRoot));
  return home === undefined ? keys : [home];
});

export const pickWinner = (
  scores: ReadonlyArray<AgentPlacementScore>,
  here: EnvironmentId,
  spill: boolean,
) =>
  scores
    .filter(
      (entry) =>
        entry.skipped === undefined && entry.score > 0 && !(spill && entry.environmentId === here),
    )
    .toSorted((left, right) => right.score - left.score)[0];
