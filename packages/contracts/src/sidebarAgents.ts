import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SidebarAgentsSettings = Schema.Struct({
  pinned: Schema.Array(Schema.String),
  hidden: Schema.Array(Schema.String),
  updatedAt: Schema.String,
});
export type SidebarAgentsSettings = typeof SidebarAgentsSettings.Type;

export const SidebarAgentsServerFields = {
  sidebarAgents: Schema.NullOr(SidebarAgentsSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
};

export const SidebarAgentsServerPatchFields = {
  sidebarAgents: Schema.optionalKey(Schema.NullOr(SidebarAgentsSettings)),
};
