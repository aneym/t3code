import * as Predicate from "effect/Predicate";
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
    if (
      this.cause instanceof Error &&
      Predicate.isTagged(this.cause, "RuntimePolicySealedAgentHomeError")
    )
      return this.cause.message;
    return `Failed to dispatch orchestration command ${this.commandType} (${this.commandId}).`;
  }
}

export class OrchestratorCommandRejectedError extends Schema.TaggedError<OrchestratorCommandRejectedError>()(
  "OrchestratorCommandRejectedError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration command ${this.commandType} (${this.commandId}) was rejected before commit.`;
  }
}

export class OrchestratorDispatchBusyError extends Schema.TaggedError<OrchestratorDispatchBusyError>()(
  "OrchestratorDispatchBusyError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    waitedMs: Schema.Number,
    retryAfterMs: Schema.Number,
  },
) {
  override get message(): string {
    return `The server is busy and did not start this command within ${Math.round(this.waitedMs / 1000)} seconds, so nothing was saved. Retry in a few seconds.`;
  }
}
