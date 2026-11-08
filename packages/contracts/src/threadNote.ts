import * as Schema from "effect/Schema";

export const QuietNoteFields = { quietNote: Schema.optional(Schema.Literal(true)) };

export const QuietNoteDispatchMode = Schema.Struct({ type: Schema.Literal("note") });
