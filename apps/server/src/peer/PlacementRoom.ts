import {
  type AgentPlacementHold,
  type AgentPlacementRoom,
  type AgentPlacementScore,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerSettings,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Gate from "../orchestration-v2/DelegatedChildStartGate.ts";
import type * as Projects from "../project/ProjectService.ts";
import { projectsByRepository } from "../project/ProjectsByRepository.ts";
import type * as PlacementSnapshots from "./PlacementSnapshots.ts";

const FULL_REASONS = ["All ", "Load per core", "Available memory", "T3 server busy", "Free disk"];

export const localSkip = (
  provider: ServerProvider | undefined,
  settings: ServerSettings,
  projectId: ProjectId | undefined,
  modelSelection: ModelSelection,
) => {
  if (projectId === undefined) return "The project is not registered here.";
  return provider !== undefined &&
    isProviderAvailable(provider) &&
    provider.enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status !== "unauthenticated" &&
    resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId) &&
    provider.models.some((model) => model.slug === modelSelection.model)
    ? undefined
    : "Provider or model unavailable here.";
};

export const peerSkip = (input: {
  readonly scored: AgentPlacementScore;
  readonly snapshot: PlacementSnapshots.Snapshot | undefined;
  readonly failure: string | undefined;
  readonly modelSelection: ModelSelection;
  readonly driver: ProviderDriverKind | undefined;
}) => {
  const { scored, snapshot, modelSelection } = input;
  if (scored.skipped === "Weight is 0.") return scored.skipped;
  if (snapshot === undefined) return input.failure;
  if (snapshot.placementProjectId === undefined)
    return (snapshot.placementProjectCount ?? 0) > 1
      ? `${snapshot.placementProjectCount} projects there match the repository; name the environment and project to use one.`
      : "The project is not registered there.";
  return snapshot.placementProviders?.some(
    (entry) =>
      entry.instanceId === modelSelection.instanceId &&
      entry.driver === input.driver &&
      entry.enabled &&
      entry.models.includes(modelSelection.model),
  )
    ? undefined
    : "Provider or model unavailable there.";
};

export const localRoom = Effect.gen(function* () {
  const gate = yield* Effect.serviceOption(Gate.DelegatedChildStartGate);
  return Option.isNone(gate) ? undefined : yield* gate.value.room;
});

export const localProject = Effect.fn("PlacementRoom.localProject")(function* (
  projects: Projects.ProjectService["Service"],
  repository: string,
) {
  const found = yield* projectsByRepository(projects, new Set([repository])).pipe(
    Effect.orElseSucceed(() => ({ matches: [], complete: false })),
  );
  return found.complete && found.matches.length === 1 ? found.matches[0]?.id : undefined;
});

export const makeClaims = () => {
  const claims = new Map<
    EnvironmentId,
    { readonly expiresAt: number; active: number; held: number }
  >();
  const adjust = (
    environmentId: EnvironmentId,
    room: AgentPlacementRoom | undefined,
    expiresAt: number | undefined,
  ): AgentPlacementRoom | undefined => {
    const claim = claims.get(environmentId);
    if (room === undefined || claim === undefined || claim.expiresAt !== expiresAt) return room;
    return {
      ...room,
      active: room.active + claim.active,
      held: room.held + claim.held,
      free: room.free === null ? null : Math.max(0, room.free - claim.active),
    };
  };
  const claim = (environmentId: EnvironmentId, expiresAt: number | undefined, held: boolean) => {
    if (expiresAt === undefined) return;
    const current = claims.get(environmentId);
    const next =
      current !== undefined && current.expiresAt === expiresAt
        ? current
        : { expiresAt, active: 0, held: 0 };
    if (held) next.held += 1;
    else next.active += 1;
    claims.set(environmentId, next);
  };
  return { adjust, claim };
};

const queueable = (score: AgentPlacementScore) =>
  score.room !== undefined &&
  score.room.paused === undefined &&
  score.weight > 0 &&
  (score.room.free === 0 ||
    FULL_REASONS.some((prefix) => score.skipped?.startsWith(prefix) === true));

const queueShare = (score: AgentPlacementScore) =>
  ((score.room?.held ?? 0) + 1) / Math.max(1, score.room?.cap ?? 1);

export const winnerReason = (winner: AgentPlacementScore) =>
  winner.room?.cap != null && winner.room.free !== null
    ? `Most room: ${winner.room.free} of ${winner.room.cap} builder slots free (score ${winner.score.toFixed(2)}).`
    : `Most weighted headroom (${winner.score.toFixed(2)}).`;

export const queuePick = (
  scores: ReadonlyArray<AgentPlacementScore>,
  matching: ReadonlyMap<EnvironmentId, ProjectId>,
  now: number,
  maxHoldMinutes: number,
) => {
  const chosen = scores
    .filter((score) => matching.has(score.environmentId) && queueable(score))
    .toSorted(
      (left, right) =>
        queueShare(left) - queueShare(right) || (right.room?.free ?? 0) - (left.room?.free ?? 0),
    )[0];
  if (chosen === undefined) return undefined;
  const position = (chosen.room?.held ?? 0) + 1;
  const hold: AgentPlacementHold = {
    reason: chosen.skipped ?? `Queued on ${chosen.label}.`,
    position,
    since: now,
    until: now + maxHoldMinutes * 60_000,
  };
  return {
    environmentId: chosen.environmentId,
    reason: `Every machine is full; queued on ${chosen.label} at position ${position}, the shortest queue.`,
    hold,
  };
};
