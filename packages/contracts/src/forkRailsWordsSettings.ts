import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const Client = {
  railsWordsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
};

export const ClientPatch = {
  railsWordsEnabled: Schema.optionalKey(Schema.Boolean),
};
