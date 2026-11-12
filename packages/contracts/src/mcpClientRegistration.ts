import * as Schema from "effect/Schema";
import { PeerIdentity } from "./messageSender.ts";

/**
 * The `software_id` another T3 Code environment registers with when it links
 * to this one. Its session is then a peer link: the work it starts here stays
 * within that link. Claiming it only ever adds limits.
 */
export const MCP_PEER_LINK_SOFTWARE_ID = "t3code-peer-link";

export const AuthMcpClientRegistration = Schema.Struct({
  client_name: Schema.optionalKey(Schema.String),
  peer_environment: Schema.optionalKey(PeerIdentity),
  software_id: Schema.optionalKey(Schema.String),
  redirect_uris: Schema.optionalKey(Schema.Array(Schema.String)),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
});
export type AuthMcpClientRegistration = typeof AuthMcpClientRegistration.Type;
