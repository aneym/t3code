import * as Schema from "effect/Schema";

import {
  AuthClientMetadata,
  AuthClientSession,
  AuthEnvironmentScopes,
  AuthGrantScopes,
  AuthPairingLink,
} from "./auth.ts";
import { AuthSessionId, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChatSessionThreadIds } from "./chatSession.ts";

export const ServerAuthSessionIssueInput = Schema.Struct({
  scopes: AuthGrantScopes.check(Schema.isMinLength(1)),
  ttlMs: Schema.optionalKey(PositiveInt),
  label: Schema.optionalKey(Schema.String),
  subject: Schema.optionalKey(Schema.String),
});
export type ServerAuthSessionIssueInput = typeof ServerAuthSessionIssueInput.Type;

export const ServerAuthIssuedSession = Schema.Struct({
  sessionId: AuthSessionId,
  token: Schema.String,
  method: Schema.Literal("bearer-access-token"),
  scopes: AuthEnvironmentScopes,
  subject: Schema.String,
  client: AuthClientMetadata,
  expiresAt: Schema.DateTimeUtc,
});
export type ServerAuthIssuedSession = typeof ServerAuthIssuedSession.Type;

export const ServerAuthSessionList = Schema.Struct({ sessions: Schema.Array(AuthClientSession) });
export type ServerAuthSessionList = typeof ServerAuthSessionList.Type;

export const ServerAuthSessionRevokeInput = Schema.Struct({ sessionId: AuthSessionId });
export type ServerAuthSessionRevokeInput = typeof ServerAuthSessionRevokeInput.Type;

export const ServerAuthSessionRevokeResult = Schema.Struct({ revoked: Schema.Boolean });
export type ServerAuthSessionRevokeResult = typeof ServerAuthSessionRevokeResult.Type;

export const ServerAuthPairingCreateInput = Schema.Struct({
  scopes: AuthGrantScopes.check(Schema.isMinLength(1)),
  chatThreadIds: Schema.optionalKey(ChatSessionThreadIds),
  ttlMs: Schema.optionalKey(PositiveInt),
  label: Schema.optionalKey(Schema.String),
});
export type ServerAuthPairingCreateInput = typeof ServerAuthPairingCreateInput.Type;

export const ServerAuthPairingLink = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  scopes: AuthEnvironmentScopes,
  subject: Schema.String,
  label: Schema.optionalKey(Schema.String),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type ServerAuthPairingLink = typeof ServerAuthPairingLink.Type;

export const ServerAuthPairingList = Schema.Struct({ pairingLinks: Schema.Array(AuthPairingLink) });
export type ServerAuthPairingList = typeof ServerAuthPairingList.Type;

export const ServerAuthPairingRevokeInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type ServerAuthPairingRevokeInput = typeof ServerAuthPairingRevokeInput.Type;
