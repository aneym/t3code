import { type EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export type Allowed = ReadonlyArray<EnvironmentId> | undefined;

const isAllowed = (allowed: Allowed, environmentId: EnvironmentId) =>
  allowed === undefined || allowed.length === 0 || allowed.includes(environmentId);

export const allowedSkip = (allowed: Allowed, environmentId: EnvironmentId) =>
  isAllowed(allowed, environmentId) ? undefined : "Not in the allowed machines.";

export const requireAllowed = (allowed: Allowed, environmentId: EnvironmentId, why?: string) =>
  isAllowed(allowed, environmentId)
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${why === undefined ? `environmentId ${environmentId}` : `This start can only run on ${environmentId} (${why.replace(/\.$/, "")}), which`} is not in allowedEnvironmentIds (${allowed?.join(", ")}).`,
        }),
      );
