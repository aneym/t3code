import * as Schema from "effect/Schema";

export const SidebarAgentsSettings = Schema.Struct({
  pinned: Schema.Array(Schema.String),
  hidden: Schema.Array(Schema.String),
  updatedAt: Schema.String,
});
export type SidebarAgentsSettings = typeof SidebarAgentsSettings.Type;
