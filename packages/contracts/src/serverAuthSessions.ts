import * as Schema from "effect/Schema";

import {
  AuthClientMetadata,
  AuthClientSession,
  AuthEnvironmentScopes,
  AuthGrantScopes,
} from "./auth.ts";
import { AuthSessionId, PositiveInt } from "./baseSchemas.ts";

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
