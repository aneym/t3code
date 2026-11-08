import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const FollowUpBehavior = Schema.Literals(["queue", "steer"]);

export const Client = {
  followUpBehavior: FollowUpBehavior.pipe(Schema.withDecodingDefault(Effect.succeed("queue"))),
  followUpBehaviorChosen: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
};

export const ClientPatch = {
  followUpBehavior: Schema.optionalKey(FollowUpBehavior),
  followUpBehaviorChosen: Schema.optionalKey(Schema.Boolean),
};
