import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ServerAuthToolkit } from "./tools.ts";

const ownerCli = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.client?.ownerCli === true) return yield* EnvironmentAuth.EnvironmentAuth;
  return yield* new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Only this server owner's t3 CLI can manage its sessions.",
  });
});

const asToolFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

const withAuth = <A>(
  use: (
    auth: EnvironmentAuth.EnvironmentAuth["Service"],
  ) => Effect.Effect<A, { readonly message: string }>,
) => ownerCli.pipe(Effect.flatMap((auth) => use(auth).pipe(Effect.mapError(asToolFailure))));

export const layer = McpToolAccess.toLayer(ServerAuthToolkit, {
  t3_auth_session_issue: McpToolAccess.reads((input) =>
    withAuth((auth) =>
      auth.issueSession({
        scopes: input.scopes,
        ...(input.ttlMs === undefined ? {} : { ttl: Duration.millis(input.ttlMs) }),
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.subject === undefined ? {} : { subject: input.subject }),
      }),
    ),
  ),
  t3_auth_session_list: McpToolAccess.reads(() =>
    withAuth((auth) => Effect.map(auth.listSessions(), (sessions) => ({ sessions }))),
  ),
  t3_auth_session_revoke: McpToolAccess.reads((input) =>
    withAuth((auth) => Effect.map(auth.revokeSession(input.sessionId), (revoked) => ({ revoked }))),
  ),
  t3_auth_pairing_create: McpToolAccess.reads((input) =>
    withAuth((auth) =>
      auth.createPairingLink({
        scopes: input.scopes,
        subject: "one-time-token",
        label: input.label ?? "t3 pair",
        ...(input.ttlMs === undefined ? {} : { ttl: Duration.millis(input.ttlMs) }),
      }),
    ),
  ),
});
