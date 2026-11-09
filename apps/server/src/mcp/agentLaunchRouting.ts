import { ModelSelection, ProjectId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AgentPlacement from "../peer/AgentPlacement.ts";
import type * as Invocation from "./McpInvocationContext.ts";

const LaunchInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  scratch: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  clientRequestId: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
  workspaceStrategy: Schema.optional(
    Schema.Struct({
      type: Schema.String,
      baseRef: Schema.optional(Schema.String),
      startFromOrigin: Schema.optional(Schema.Boolean),
    }),
  ),
});

const decodeInput = Schema.decodeUnknownEffect(LaunchInput);
const sharedBase = (strategy: (typeof LaunchInput.Type)["workspaceStrategy"]) =>
  strategy?.type === "worktree" &&
  strategy.baseRef !== undefined &&
  !/^[0-9a-f]{7,40}$/i.test(strategy.baseRef) &&
  (strategy.baseRef.startsWith("origin/") || strategy.startFromOrigin === true);

export const prepare = Effect.fn("AgentLaunchRouting.prepare")(function* (
  service: AgentPlacement.AgentPlacement["Service"],
  scope: Invocation.McpInvocationScope,
  params: unknown,
) {
  const input = yield* decodeInput(params).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Invalid launch parameters.",
        }),
    ),
  );
  const selected = yield* service.select(scope, {
    operation: "launch",
    projectId: input.projectId,
    modelSelection: input.modelSelection,
    clientRequestId: input.clientRequestId,
    ...(input.scratch === true
      ? { localOnlyReason: "Scratch work has no shared project to match." }
      : (input.attachments?.length ?? 0) > 0
        ? { localOnlyReason: "Pending attachments belong to this environment." }
        : input.workspaceStrategy !== undefined &&
            input.workspaceStrategy.type !== "root" &&
            !sharedBase(input.workspaceStrategy)
          ? { localOnlyReason: "Worktree launches keep their local base references." }
          : {}),
  });
  if (selected === undefined)
    return { environmentId: undefined, params: params as object, placement: undefined };
  const remote = selected.placement.environmentId !== scope.environmentId;
  return {
    environmentId: selected.placement.environmentId,
    placement: selected.placement,
    params: remote
      ? {
          ...(params as object),
          projectId: selected.projectId,
          modelSelection: selected.modelSelection,
        }
      : (params as object),
  };
});
