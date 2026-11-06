import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { McpAppToolGrant } from "./mcpApps.ts";

const Grants = Schema.Array(McpAppToolGrant);

export const Server = {
  mcpAppRememberToolGrants: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  mcpAppToolGrants: Grants.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
};

export const ServerPatch = {
  mcpAppRememberToolGrants: Schema.optionalKey(Schema.Boolean),
  mcpAppToolGrants: Schema.optionalKey(Grants),
};
