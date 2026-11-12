import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

const Origins = Schema.Array(TrimmedString);

const APP_CARD_DEFAULT_ALLOWED_ORIGINS = ["https://one.rails.so", "https://preview.onrails.app"];

export const Server = {
  appCardsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  appCardAllowedOrigins: Origins.pipe(
    Schema.withDecodingDefault(Effect.succeed(APP_CARD_DEFAULT_ALLOWED_ORIGINS)),
  ),
};

export const ServerPatch = {
  appCardsEnabled: Schema.optionalKey(Schema.Boolean),
  appCardAllowedOrigins: Schema.optionalKey(Origins),
};
