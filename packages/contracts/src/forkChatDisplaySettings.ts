import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const DefaultTrue = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));

export const Client = {
  hideTrailingStageLine: DefaultTrue,
  keepOpeningReplyVisible: DefaultTrue,
};

export const ClientPatch = {
  hideTrailingStageLine: Schema.optionalKey(Schema.Boolean),
  keepOpeningReplyVisible: Schema.optionalKey(Schema.Boolean),
};
