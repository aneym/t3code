import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SidebarAgentsSettings = Schema.Struct({
  pinned: Schema.Array(Schema.String),
  hidden: Schema.Array(Schema.String),
  order: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  updatedAt: Schema.String,
});
export type SidebarAgentsSettings = typeof SidebarAgentsSettings.Type;
