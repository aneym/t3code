import * as Schema from "effect/Schema";
import {
  AuthSessionId,
  AuthEnvironmentScopes,
  RuntimeMode,
  PeerIdentity,
} from "@t3tools/contracts";

export const SessionClaims = Schema.Struct({
  v: Schema.Literals([1, 2]),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: Schema.Literals(["browser-session-cookie", "bearer-access-token", "dpop-access-token"]),
  jkt: Schema.optionalKey(Schema.String),
  rtc: Schema.optionalKey(RuntimeMode),
  /** Signed, so a client cannot shed its peer link's limits. */
  peer: Schema.optionalKey(PeerIdentity),
  plk: Schema.optionalKey(Schema.Literal(1)),
  iat: Schema.Number,
  exp: Schema.Number,
});
export type SessionClaims = typeof SessionClaims.Type;
