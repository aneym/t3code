import * as Schema from "effect/Schema";
import { PeerIdentity, type AuthMcpClientAccess } from "@t3tools/contracts";

export const ClientIdPayload = Schema.Struct({
  v: Schema.Literal(1),
  n: Schema.String,
  r: Schema.Array(Schema.String),
  /** Registered as another T3 Code environment's peer link. */
  p: Schema.optionalKey(Schema.Literal(1)),
  e: Schema.optionalKey(PeerIdentity),
});
export const decodeClientIdPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClientIdPayload),
);

export interface McpOAuthClient {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
  readonly peerLink: boolean;
  readonly peer?: PeerIdentity | undefined;
}

export interface PendingCode {
  readonly clientId: string;
  readonly clientName: string;
  readonly peerLink: boolean;
  readonly peer?: PeerIdentity | undefined;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly access: AuthMcpClientAccess;
  readonly expiresAtMs: number;
}
