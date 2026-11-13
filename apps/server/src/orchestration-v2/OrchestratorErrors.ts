import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  RuntimeMode,
  ProviderInteractionMode,
  managedRuntimeModeCeilingMessage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchBusyError,
  OrchestratorDispatchError,
} from "./OrchestratorDispatchError.ts";

export class OrchestratorThreadAlreadyExistsError extends Schema.TaggedError<OrchestratorThreadAlreadyExistsError>()(
  "OrchestratorThreadAlreadyExistsError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} already exists. Use a new thread id.`;
  }
}

export class OrchestratorProjectionError extends Schema.TaggedError<OrchestratorProjectionError>()(
  "OrchestratorProjectionError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to load orchestration projection for thread ${this.threadId}.`;
  }
}

export class OrchestratorDomainEventStreamError extends Schema.TaggedError<OrchestratorDomainEventStreamError>()(
  "OrchestratorDomainEventStreamError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed while streaming orchestration domain events.";
  }
}

export class OrchestratorProviderAdapterError extends Schema.TaggedError<OrchestratorProviderAdapterError>()(
  "OrchestratorProviderAdapterError",
  {
    commandId: CommandId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter failed while dispatching orchestration command ${this.commandId}.`;
  }
}

export class OrchestratorSubagentThreadReadOnlyError extends Schema.TaggedError<OrchestratorSubagentThreadReadOnlyError>()(
  "OrchestratorSubagentThreadReadOnlyError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return "This subagent is run by its provider and cannot take messages. Message the parent thread instead.";
  }
}

export class OrchestratorThreadAboveModeLimitError extends Schema.TaggedError<OrchestratorThreadAboveModeLimitError>()(
  "OrchestratorThreadAboveModeLimitError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    mode: Schema.Literals(["runtime", "interaction"]),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} now runs in ${this.runtimeMode}/${this.interactionMode} mode, above what this caller may change.`;
  }
}

export class OrchestratorCommandPreviouslyRejectedError extends Schema.TaggedError<OrchestratorCommandPreviouslyRejectedError>()(
  "OrchestratorCommandPreviouslyRejectedError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was previously rejected: ${this.detail}`;
  }
}

export class OrchestratorCommandIdConflictError extends Schema.TaggedError<OrchestratorCommandIdConflictError>()(
  "OrchestratorCommandIdConflictError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    receiptThreadId: ThreadId,
    commandThreadId: ThreadId,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was already handled for thread ${this.receiptThreadId} and cannot be replayed for ${this.commandThreadId}.`;
  }
}

export class OrchestratorRuntimeModeAboveCeilingError extends Schema.TaggedError<OrchestratorRuntimeModeAboveCeilingError>()(
  "OrchestratorRuntimeModeAboveCeilingError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    refused: Schema.Literals(["mode", "turn"]),
    runtimeMode: RuntimeMode,
    maxRuntimeMode: RuntimeMode,
    organization: Schema.String,
  },
) {
  override get message(): string {
    const limit = managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode);
    return this.refused === "turn" ? `${limit} Switch this thread's mode to continue.` : limit;
  }
}

export class OrchestratorProviderSelectionBusyError extends Schema.TaggedError<OrchestratorProviderSelectionBusyError>()(
  "OrchestratorProviderSelectionBusyError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} has an active turn. Wait for it to finish, then retry the provider selection change.`;
  }
}

export const OrchestratorV2Error = Schema.Union([
  OrchestratorDispatchError,
  OrchestratorDispatchBusyError,
  OrchestratorThreadAlreadyExistsError,
  OrchestratorCommandRejectedError,
  OrchestratorProjectionError,
  OrchestratorDomainEventStreamError,
  OrchestratorProviderAdapterError,
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorCommandIdConflictError,
  OrchestratorSubagentThreadReadOnlyError,
  OrchestratorThreadAboveModeLimitError,
  OrchestratorProviderSelectionBusyError,
  OrchestratorRuntimeModeAboveCeilingError,
]);
export type OrchestratorV2Error = typeof OrchestratorV2Error.Type;
