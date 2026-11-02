import * as Schema from "effect/Schema";
import { RunId } from "./baseSchemas.ts";

export const RestartRunState = Schema.Struct({
  restartContinuationOfRunId: Schema.optional(RunId),
  restartHandoffPending: Schema.optional(Schema.Boolean),
  restartDeclined: Schema.optional(
    Schema.Literals(["chain_limit", "provider_disabled", "native_maintenance", "dispatch_failed"]),
  ),
});
