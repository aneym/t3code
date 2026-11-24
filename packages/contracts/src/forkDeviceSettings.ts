import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

export const Server = {
  localDeviceDeveloperDir: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
};

export const ServerPatch = {
  localDeviceDeveloperDir: Schema.optionalKey(TrimmedString),
};
