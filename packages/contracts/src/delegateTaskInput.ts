import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  OrchestratorMcpClientRequestId,
  OrchestratorMcpInteractionMode,
  OrchestratorMcpPrompt,
  OrchestratorMcpRuntimeMode,
  OrchestratorMcpTitle,
} from "./orchestratorMcp.ts";
import {
  OrchestratorMcpAllowedEnvironments,
  OrchestratorMcpTarget,
} from "./orchestratorMcpTarget.ts";

export const OrchestratorMcpTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;

export const OrchestratorMcpDelegateTaskInput = Schema.Struct({
  task: OrchestratorMcpPrompt,
  target: Schema.optional(
    Schema.Struct({
      ...OrchestratorMcpTarget.fields,
      allowedEnvironmentIds: Schema.optional(OrchestratorMcpAllowedEnvironments),
    }),
  ),
  title: Schema.optional(OrchestratorMcpTitle),
  role: Schema.optional(OrchestratorMcpTaskRole),
  isolation: Schema.optional(
    Schema.Literals(["shared", "worktree"]).annotate({
      description:
        "'shared' (default): parent checkout, or another project's folder. 'worktree': new prepared checkout from a freshly fetched origin default branch unless worktreeBase is 'parent', for a separate checkout or PR per child. Uncommitted edits stay out.",
    }),
  ),
  worktreeBase: Schema.optional(
    Schema.Literals(["origin", "parent"]).annotate({
      description:
        "Isolation 'worktree' without baseRef. 'origin' (default): freshly fetched origin default branch. 'parent': the parent checkout's commit, for a child that must build on the parent's unpushed commits.",
    }),
  ),
  baseRef: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Isolation 'worktree': branch, tag, or commit in the task's project to start from, on target.environmentId when set.",
    }),
  ),
  mode: Schema.optional(
    Schema.Literals(["async", "wait"]).annotate({
      description:
        "Default 'async'. 'wait' only if this turn needs the result. A question, approval or held start ends the wait.",
    }),
  ),
  awaited: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True if its result should wake you as soon as it ends. Otherwise a clean result waits as a note until your last child ends.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Finite).annotate({
    description: "Mode 'wait' only. Default 4 min. A timeout does not cancel the child.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  runtimeMode: Schema.optional(
    OrchestratorMcpRuntimeMode.annotate({
      description:
        "Omit unless the user asks for a supervised child. Narrow modes pause for human approval, not read-only. Above yours is rejected.",
    }),
  ),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
  class: Schema.optional(
    Schema.Literal("light").annotate({
      description:
        "'light': a quick housekeeping task that starts at once in a pool of its own on this machine, even when builds wait on load. Shared isolation only; it stays here.",
    }),
  ),
});
export type OrchestratorMcpDelegateTaskInput = typeof OrchestratorMcpDelegateTaskInput.Type;
