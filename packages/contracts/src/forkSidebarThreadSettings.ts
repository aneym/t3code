import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const DefaultTrue = Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)));

export const Client = {
  sidebarThreadShowMachine: DefaultTrue,
  sidebarThreadShowAgent: DefaultTrue,
  sidebarThreadShowStatusText: DefaultTrue,
};

export const ClientPatch = {
  sidebarThreadShowMachine: Schema.optionalKey(Schema.Boolean),
  sidebarThreadShowAgent: Schema.optionalKey(Schema.Boolean),
  sidebarThreadShowStatusText: Schema.optionalKey(Schema.Boolean),
};
