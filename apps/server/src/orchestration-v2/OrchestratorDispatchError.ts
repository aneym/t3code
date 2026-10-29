import * as Schema from "effect/Schema";
import { CommandId, ThreadOrganizeRefusalReason } from "@t3tools/contracts";

export class OrchestratorDispatchError extends Schema.TaggedError<OrchestratorDispatchError>()(
  "OrchestratorDispatchError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    reason: Schema.optional(ThreadOrganizeRefusalReason),
  },
) {
  override get message(): string {
    return `Failed to dispatch orchestration command ${this.commandType} (${this.commandId}).`;
  }
}
