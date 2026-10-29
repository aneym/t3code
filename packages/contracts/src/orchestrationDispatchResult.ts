import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

export const OrchestrationV2DispatchCommandResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type OrchestrationV2DispatchCommandResult = typeof OrchestrationV2DispatchCommandResult.Type;
