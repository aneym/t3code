import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";

export const ModelSelectionPrecondition = Schema.Struct({
  modelSelection: ModelSelection,
  expectedModelSelection: Schema.optional(ModelSelection),
});
