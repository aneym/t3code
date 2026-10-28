import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ServerRestartHandoff } from "./serverRestart.ts";

export const ServerImportRestartHandoffInput = Schema.Struct({
  epoch: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  startedAt: IsoDateTime,
  capturedSequence: NonNegativeInt,
  threads: Schema.Array(ServerRestartHandoff),
});
export type ServerImportRestartHandoffInput = typeof ServerImportRestartHandoffInput.Type;

export class ServerImportRestartHandoffError extends Schema.TaggedError<ServerImportRestartHandoffError>()(
  "ServerImportRestartHandoffError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The previous server's restart handoff could not be imported.";
  }
}
