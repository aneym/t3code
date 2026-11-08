import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

const Origins = Schema.Array(TrimmedString);

export const Server = {
  embedModeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  embedAllowedOrigins: Origins.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
};

export const ServerPatch = {
  embedModeEnabled: Schema.optionalKey(Schema.Boolean),
  embedAllowedOrigins: Schema.optionalKey(Origins),
};
