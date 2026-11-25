import { type EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Links from "./PeerLinks.ts";

export type Allowed = ReadonlyArray<EnvironmentId> | undefined;

const isAllowed = (allowed: Allowed, environmentId: EnvironmentId) =>
  allowed === undefined || allowed.includes(environmentId);

const invalid = (message: string) =>
  Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message }));

export const allowedSkip = (
  allowed: Allowed,
  environmentId: EnvironmentId,
  explicitOnly: ReadonlyArray<EnvironmentId>,
) =>
  !isAllowed(allowed, environmentId)
    ? "Not in the allowed machines."
    : allowed === undefined && explicitOnly.includes(environmentId)
      ? "Takes only starts that name it in allowedEnvironmentIds."
      : undefined;

export const requireAllowed = (allowed: Allowed, environmentId: EnvironmentId, why?: string) =>
  isAllowed(allowed, environmentId)
    ? Effect.void
    : invalid(
        `${why === undefined ? `environmentId ${environmentId}` : `This start can only run on ${environmentId} (${why.replace(/\.$/, "")}), which`} is not in allowedEnvironmentIds (${allowed?.join(", ")}).`,
      );

export const checkAllowed = Effect.fn("PlacementAllowed.checkAllowed")(function* (
  here: EnvironmentId,
  allowed: Allowed,
) {
  if (allowed === undefined) return;
  if (allowed.length === 0)
    return yield* invalid(
      `allowedEnvironmentIds is empty. List at least one machine (this one is ${here}), or leave it out.`,
    );
  const links = yield* Effect.serviceOption(Links.PeerLinks);
  const linked = Option.isSome(links)
    ? yield* links.value.stored.pipe(Effect.orElseSucceed(() => []))
    : [];
  const known = new Set<string>([here, ...linked.map((link) => link.environmentId)]);
  const unknown = allowed.filter((environmentId) => !known.has(environmentId));
  if (unknown.length > 0)
    return yield* invalid(
      `allowedEnvironmentIds names ${unknown.join(", ")}, which is neither this machine (${here}) nor a linked one. See t3_environment_links.`,
    );
});
