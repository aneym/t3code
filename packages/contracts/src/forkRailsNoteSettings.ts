import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const Server = {
  laneResultRowsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  railsCommentCardsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
};

export const ServerPatch = {
  laneResultRowsEnabled: Schema.optionalKey(Schema.Boolean),
  railsCommentCardsEnabled: Schema.optionalKey(Schema.Boolean),
};
