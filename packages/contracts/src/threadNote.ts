import * as Schema from "effect/Schema";

export const QuietNoteFields = { quietNote: Schema.optional(Schema.Literal(true)) };

export const QuietNoteDispatchMode = Schema.Struct({ type: Schema.Literal("note") });

export const quietNoteOf = (item: object) =>
  "quietNote" in item && item.quietNote === true ? { quietNote: true as const } : {};
