import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);

export function failure(
  code: OrchestratorMcpFailure["code"],
  message: string,
): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function threadManagementFailure(error: unknown): OrchestratorMcpFailure {
  if (!isThreadManagementError(error)) return failure("orchestration_error", errorMessage(error));
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return failure("thread_not_found", error.message);
    case "ThreadManagementRunNotFoundError":
      return failure("run_not_found", error.message);
    case "ThreadManagementThreadArchivedError":
    case "ThreadManagementNoSteerableRunError":
      return failure("thread_not_sendable", error.message);
    case "ThreadManagementThreadNotInterruptibleError":
      return failure("thread_not_interruptible", error.message);
    case "ThreadManagementProjectionLoadError":
    case "ThreadManagementProjectThreadsListError":
    case "ThreadManagementDurableRunProjectionError":
      return failure("orchestration_error", error.message);
    case "ThreadManagementSendConflictError":
      return failure(
        "invalid_request",
        "This clientRequestId already belongs to a different send to this thread, or that send was rejected. Retry with the same message and mode, or use a new clientRequestId.",
      );
    case "ThreadManagementProviderInstanceDisabledError":
      return failure("invalid_request", error.message);
  }
}
