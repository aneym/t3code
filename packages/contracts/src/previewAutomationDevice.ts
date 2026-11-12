import { Schema } from "effect";

export const PreviewAutomationDevice = Schema.Struct({
  name: Schema.String,
  focused: Schema.Boolean,
  lastFocusedAt: Schema.Number,
  control: Schema.optional(Schema.Boolean),
});
