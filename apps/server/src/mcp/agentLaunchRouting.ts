import {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AgentPlacement from "../peer/AgentPlacement.ts";
import { checkAllowed, requireAllowed } from "../peer/PlacementAllowed.ts";
import type * as Invocation from "./McpInvocationContext.ts";

const LaunchInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  repository: Schema.optional(Schema.String),
  scratch: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  clientRequestId: Schema.optional(Schema.String),
  allowedEnvironmentIds: Schema.optional(Schema.Array(EnvironmentId)),
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
  workspaceStrategy: Schema.optional(
    Schema.Struct({
      type: Schema.String,
      baseRef: Schema.optional(Schema.String),
      startFromOrigin: Schema.optional(Schema.Boolean),
    }),
  ),
});

const decodeLaunch = Schema.decodeUnknownEffect(LaunchInput);
const decodeInput = (scope: Invocation.McpInvocationScope, params: object) =>
  decodeLaunch(params).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Invalid launch parameters.",
        }),
    ),
    Effect.tap((input) => checkAllowed(scope.environmentId, input.allowedEnvironmentIds)),
  );
const withoutAllowed = (params: object) => {
  const { allowedEnvironmentIds: _allowed, ...rest } = params as {
    readonly allowedEnvironmentIds?: unknown;
  };
  return rest;
};

export const unplaced = Effect.fn("AgentLaunchRouting.unplaced")(function* (
  scope: Invocation.McpInvocationScope,
  environmentId: EnvironmentId | undefined,
  params: object,
) {
  const input = yield* decodeInput(scope, params);
  yield* requireAllowed(
    input.allowedEnvironmentIds,
    environmentId ?? scope.environmentId,
    environmentId === undefined ? "Automatic placement is off here." : undefined,
  );
  return withoutAllowed(params);
});
const sharedBase = (strategy: (typeof LaunchInput.Type)["workspaceStrategy"]) =>
  strategy?.type === "worktree" &&
  strategy.baseRef !== undefined &&
  !/^[0-9a-f]{7,40}$/i.test(strategy.baseRef) &&
  (strategy.baseRef.startsWith("origin/") || strategy.startFromOrigin === true);

export const launch = Effect.fn("AgentLaunchRouting.launch")(function* <E, R>(
  service: AgentPlacement.AgentPlacement["Service"],
  scope: Invocation.McpInvocationScope,
  params: object,
  run: (environmentId: EnvironmentId | undefined, params: object) => Effect.Effect<unknown, E, R>,
) {
  const input = yield* decodeInput(scope, params);
  const plain = withoutAllowed(params);
  const selected = yield* service.select(scope, {
    operation: "launch",
    projectId: input.projectId,
    repository: input.repository,
    modelSelection: input.modelSelection,
    clientRequestId: input.clientRequestId,
    allowed: input.allowedEnvironmentIds,
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
    return yield* run(undefined, yield* unplaced(scope, undefined, params));
  const { result, placement } = yield* service.run(
    scope,
    selected,
    input.clientRequestId,
    (clientRequestId) =>
      run(selected.placement.environmentId, {
        ...plain,
        clientRequestId,
        ...(selected.projectId === undefined
          ? {}
          : { projectId: selected.projectId, repository: undefined }),
        modelSelection: selected.modelSelection,
      }),
    requireAllowed(
      input.allowedEnvironmentIds,
      scope.environmentId,
      `${selected.placement.label} was chosen and did not take it`,
    ).pipe(Effect.andThen(run(undefined, plain))),
  );
  if (typeof result !== "object" || result === null) return result;
  if ("threadId" in result && typeof result.threadId === "string")
    yield* service.record(result.threadId, placement);
  return { ...result, placement };
});
