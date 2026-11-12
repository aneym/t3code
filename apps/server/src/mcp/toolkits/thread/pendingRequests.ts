import {
  type OrchestrationV2RuntimeRequest,
  OrchestratorMcpFailure,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { dispatchFailure, newCommandId, readThread, unavailable } from "../../threadAccess.ts";

const DEFAULT_OFFERED: ReadonlyArray<ProviderApprovalDecision> = [
  "cancel",
  "decline",
  "acceptForSession",
  "accept",
];

const dismissible = (request: OrchestrationV2RuntimeRequest) =>
  request.kind === "user_input" && request.responseCapability.type === "message";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const approvalAccess = Effect.fn("mcp.pendingRequest.approvalAccess")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const client = scope.client;
  if (
    scope.thread !== undefined ||
    client === undefined ||
    client.linked === true ||
    client.access === "read-only"
  )
    return "agent" as const;
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.mapError(unavailable),
  );
  return settings.mcpClientApprovals ? ("person" as const) : ("off" as const);
});

const loadPending = Effect.fn("mcp.pendingRequest.load")(function* (
  threadId: ThreadId | undefined,
  requestId: RuntimeRequestId,
  approvals: boolean,
) {
  const context = yield* readThread(
    threadId,
    ["runtimeRequests", "turnItems"],
    approvals ? ["user_input_request", "approval_request"] : ["user_input_request"],
  );
  const request = context.projection.runtimeRequests.find((request) => request.id === requestId);
  const item = context.projection.turnItems.find(
    (item) =>
      (item.type === "user_input_request" || item.type === "approval_request") &&
      item.requestId === requestId,
  );
  const question = request?.kind === "user_input" && item?.type === "user_input_request";
  const approval = approvals && item?.type === "approval_request" && request?.kind !== "user_input";
  if (request === undefined || (!question && !approval))
    return yield* invalid(
      approvals
        ? "The pending request was not found."
        : "The pending user-input request was not found.",
    );
  if (request.status !== "pending")
    return yield* invalid(
      request.status === "resolved"
        ? question
          ? "The user-input request was already answered."
          : "The permission request was already decided."
        : `The ${question ? "user-input" : "permission"} request is no longer pending (${request.status}).`,
    );
  return { ...context, request, item: item! };
});

export const list = Effect.fn("mcp.pendingRequest.list")(function* (threadId?: ThreadId) {
  const approvals = (yield* approvalAccess()) === "person";
  const { projection } = yield* readThread(threadId, ["runtimeRequests"]);
  const pending = projection.runtimeRequests.filter(
    (request) =>
      request.status === "pending" &&
      (request.kind === "user_input" ||
        (approvals && request.kind !== "dynamic_tool_call" && request.kind !== "auth_refresh")),
  );
  return {
    requestIds: pending.map((request) => request.id),
    dismissibleRequestIds: pending.filter(dismissible).map((request) => request.id),
  };
});

export const read = Effect.fn("mcp.pendingRequest.read")(function* (
  threadId: ThreadId | undefined,
  requestId: RuntimeRequestId,
) {
  const approvals = (yield* approvalAccess()) === "person";
  const { item, request } = yield* loadPending(threadId, requestId, approvals);
  return item.type === "user_input_request"
    ? { requestId, questions: item.questions, dismissible: dismissible(request) }
    : {
        requestId,
        kind: "approval" as const,
        prompt: item.prompt ?? null,
        reason: item.reason ?? null,
      };
});

export const respond = Effect.fn("mcp.pendingRequest.respond")(function* (input: {
  readonly threadId: ThreadId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly answers: ProviderUserInputAnswers | undefined;
  readonly decision: "accept" | "decline" | "acceptForSession" | undefined;
}) {
  if (input.answers !== undefined && input.decision !== undefined)
    return yield* invalid(
      "Give `answers` for a question or `decision` for a permission request, not both.",
    );
  if (input.decision === undefined) {
    if (input.answers === undefined) return yield* invalid("This action needs `answers`.");
    const { threads, projection } = yield* loadPending(input.threadId, input.requestId, false);
    return yield* dispatchRespond(threads, projection.thread.id, input.requestId, {
      answers: input.answers,
    });
  }
  const access = yield* approvalAccess();
  if (access === "agent")
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Only a person's MCP client can approve or decline a permission request. An agent cannot decide one, for its own thread or any other.",
    });
  if (access === "off")
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Approvals from MCP clients are off in this environment's settings, so approve or decline it in T3 Code.",
    });
  const { threads, projection, item } = yield* loadPending(input.threadId, input.requestId, true);
  if (item.type !== "approval_request")
    return yield* invalid("This request is a question. Answer it with `answers`.");
  const offered = item.options?.map((option) => option.decision) ?? DEFAULT_OFFERED;
  if (!offered.includes(input.decision))
    return yield* invalid(
      `This permission request does not offer ${input.decision}. It offers: ${offered.join(", ")}.`,
    );
  return yield* dispatchRespond(threads, projection.thread.id, input.requestId, {
    decision: input.decision,
  });
});

export const dismiss = Effect.fn("mcp.pendingRequest.dismiss")(function* (
  threadId: ThreadId | undefined,
  requestId: RuntimeRequestId,
) {
  const { threads, projection } = yield* loadPending(threadId, requestId, false);
  const result = yield* threads
    .dispatch({
      type: "thread.user-input.dismiss",
      threadId: projection.thread.id,
      commandId: yield* newCommandId(),
      requestId,
    })
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const dispatchRespond = Effect.fn("mcp.pendingRequest.dispatchRespond")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "dispatch">,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  response:
    | { readonly answers: ProviderUserInputAnswers }
    | { readonly decision: ProviderApprovalDecision },
) {
  const result = yield* threads
    .dispatch({
      type: "runtime-request.respond",
      threadId,
      commandId: yield* newCommandId(),
      requestId,
      ...response,
    })
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});
