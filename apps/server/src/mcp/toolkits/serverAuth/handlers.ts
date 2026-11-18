import {
  AuthChatThreadsScope,
  chatSessionSubject,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ChatThreadSets from "../../../chatSession/ChatThreadSets.ts";
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

const withAuth = <A, R = never>(
  use: (
    auth: EnvironmentAuth.EnvironmentAuth["Service"],
  ) => Effect.Effect<A, { readonly message: string }, R>,
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
      Effect.gen(function* () {
        const owners = input.chatOwnerThreadIds ?? [];
        const members = [...new Set([...(input.chatThreadIds ?? []), ...owners])];
        const target =
          members.length === 0
            ? { scopes: input.scopes, subject: "one-time-token" }
            : {
                scopes: [AuthChatThreadsScope],
                subject: chatSessionSubject(
                  yield* (yield* ChatThreadSets.ChatThreadSets).create(members, owners),
                ),
              };
        return yield* auth.createPairingLink({
          ...target,
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.ttlMs === undefined ? {} : { ttl: Duration.millis(input.ttlMs) }),
        });
      }),
    ),
  ),
  t3_auth_pairing_list: McpToolAccess.reads(() =>
    withAuth((auth) =>
      Effect.map(
        auth.listPairingLinks({
          excludeSubjects: [EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT],
        }),
        (pairingLinks) => ({ pairingLinks }),
      ),
    ),
  ),
  t3_auth_pairing_revoke: McpToolAccess.reads((input) =>
    withAuth((auth) => Effect.map(auth.revokePairingLink(input.id), (revoked) => ({ revoked }))),
  ),
});
