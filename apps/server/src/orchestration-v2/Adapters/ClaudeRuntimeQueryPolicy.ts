import type {
  HookCallback,
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export const CLAUDE_READ_ONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;

const RAILS_ASK_ONLY_ENV = "RAILS_ASK_ONLY";

type ClaudePolicyTurn = Pick<
  ProviderAdapter.ProviderAdapterV2TurnInput,
  "runtimePolicy" | "appThread"
>;

const isAskOnlyTurn = (turn: Pick<ClaudePolicyTurn, "appThread">) =>
  turn.appThread.lineage.askOnly === true;

const ClaudeRuntimeSandboxPolicyKind = Schema.Struct({
  type: Schema.Literals(["dangerFullAccess", "externalSandbox", "readOnly", "workspaceWrite"]),
});
type ClaudeRuntimeSandboxPolicy = typeof ClaudeRuntimeSandboxPolicyKind.Type;
type ClaudeRuntimeSandboxPolicyKindName = ClaudeRuntimeSandboxPolicy["type"];
const isClaudeRuntimeSandboxPolicyKind = Schema.is(ClaudeRuntimeSandboxPolicyKind);

const ClaudeRuntimeReadOnlyFullAccessSandboxPolicy = Schema.Struct({
  type: Schema.Literal("readOnly"),
  access: Schema.Struct({
    type: Schema.Literal("fullAccess"),
  }),
});
const isClaudeRuntimeReadOnlyFullAccessSandboxPolicy = Schema.is(
  ClaudeRuntimeReadOnlyFullAccessSandboxPolicy,
);

function sandboxPolicyKindForClaudeRuntimePolicy(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): ClaudeRuntimeSandboxPolicyKindName | undefined {
  return runtimePolicy.sandboxPolicy !== undefined &&
    isClaudeRuntimeSandboxPolicyKind(runtimePolicy.sandboxPolicy)
    ? runtimePolicy.sandboxPolicy.type
    : undefined;
}

function readOnlyPolicyAllowsGlobalReads(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): boolean {
  return (
    runtimePolicy.sandboxPolicy !== undefined &&
    isClaudeRuntimeReadOnlyFullAccessSandboxPolicy(runtimePolicy.sandboxPolicy)
  );
}

export function permissionModeForClaudeRuntimePolicy(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): PermissionMode {
  if (runtimePolicy.interactionMode === "plan") {
    return "plan";
  }
  if (runtimePolicy.approvalPolicy === "never") {
    switch (sandboxPolicyKindForClaudeRuntimePolicy(runtimePolicy)) {
      case "readOnly":
        return "dontAsk";
      case "dangerFullAccess":
      case "externalSandbox":
        return "bypassPermissions";
      case "workspaceWrite":
      case undefined:
        return runtimePolicy.runtimeMode === "approval-required"
          ? "dontAsk"
          : runtimePolicy.runtimeMode === "auto-accept-edits"
            ? "acceptEdits"
            : "bypassPermissions";
    }
  }
  if (runtimePolicy.approvalPolicy !== undefined && runtimePolicy.approvalPolicy !== "never") {
    return "default";
  }

  switch (sandboxPolicyKindForClaudeRuntimePolicy(runtimePolicy)) {
    case "readOnly":
      return "dontAsk";
    case "dangerFullAccess":
      return runtimePolicy.runtimeMode === "approval-required" ? "default" : "bypassPermissions";
    case "externalSandbox":
    case "workspaceWrite":
    case undefined:
      break;
  }

  switch (runtimePolicy.runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "full-access":
      return "bypassPermissions";
  }
}

export interface ClaudeRuntimeQueryPolicy {
  readonly permissionMode: PermissionMode;
  readonly tools?: ReadonlyArray<string>;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: true;
  readonly installPermissionCallback: boolean;
}

export interface ClaudeBypassAvailability {
  readonly bypassDisabled: boolean;
  readonly autoDisabled: boolean;
}

const CLAUDE_BYPASS_FULLY_AVAILABLE: ClaudeBypassAvailability = {
  bypassDisabled: false,
  autoDisabled: false,
};

export function claudeRuntimeQueryPolicyForRuntimePolicy(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  availability: ClaudeBypassAvailability = CLAUDE_BYPASS_FULLY_AVAILABLE,
): ClaudeRuntimeQueryPolicy {
  const requestedMode = permissionModeForClaudeRuntimePolicy(runtimePolicy);
  const downgraded = requestedMode === "bypassPermissions" && availability.bypassDisabled;
  const permissionMode = downgraded
    ? availability.autoDisabled
      ? "default"
      : "auto"
    : requestedMode;
  const readOnlyTools =
    sandboxPolicyKindForClaudeRuntimePolicy(runtimePolicy) === "readOnly"
      ? CLAUDE_READ_ONLY_ALLOWED_TOOLS
      : undefined;
  const allowedTools =
    readOnlyTools !== undefined && readOnlyPolicyAllowsGlobalReads(runtimePolicy)
      ? readOnlyTools
      : undefined;
  // acceptEdits approves edits before the callback; the callback must ask for everything else.
  const installPermissionCallback =
    downgraded ||
    (runtimePolicy.approvalPolicy === undefined
      ? runtimePolicy.runtimeMode === "approval-required" ||
        runtimePolicy.runtimeMode === "auto-accept-edits"
      : runtimePolicy.approvalPolicy !== "never");

  if (permissionMode === "plan") {
    return {
      permissionMode,
      ...(readOnlyTools === undefined ? {} : { tools: readOnlyTools }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      // Claude routes Plan-mode writes to the callback even in Auto or Full access.
      installPermissionCallback: true,
    };
  }

  return {
    permissionMode,
    ...(readOnlyTools === undefined ? {} : { tools: readOnlyTools }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    installPermissionCallback,
  };
}

const CLAUDE_ASK_ONLY_QUERY_POLICY: ClaudeRuntimeQueryPolicy = {
  permissionMode: "dontAsk",
  allowedTools: CLAUDE_READ_ONLY_ALLOWED_TOOLS,
  installPermissionCallback: false,
};

export function claudeRuntimeQueryPolicyForTurn(
  turn: ClaudePolicyTurn,
  availability: ClaudeBypassAvailability = CLAUDE_BYPASS_FULLY_AVAILABLE,
): ClaudeRuntimeQueryPolicy {
  return isAskOnlyTurn(turn)
    ? CLAUDE_ASK_ONLY_QUERY_POLICY
    : claudeRuntimeQueryPolicyForRuntimePolicy(turn.runtimePolicy, availability);
}

const McpServerStatuses = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    status: Schema.String,
    tools: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          annotations: Schema.optional(
            Schema.Struct({ readOnly: Schema.optional(Schema.Boolean) }),
          ),
        }),
      ),
    ),
  }),
);
const decodeMcpServerStatuses = Schema.decodeUnknownEffect(McpServerStatuses);
const mcpRuleName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/gu, "_");

interface AskOnlyMcpQuery<E> {
  readonly mcpServerStatus?: Effect.Effect<ReadonlyArray<unknown>, E>;
  readonly applyFlagSettings: (settings: {
    readonly permissions: { allow: Array<string> };
  }) => Effect.Effect<void, E>;
}

export const allowAskOnlyReadOnlyMcpTools = Effect.fn(
  "ClaudeRuntimeQueryPolicy.allowAskOnlyReadOnlyMcpTools",
)(function* <E>(turn: Pick<ClaudePolicyTurn, "appThread">, query: AskOnlyMcpQuery<E>) {
  if (!isAskOnlyTurn(turn) || query.mcpServerStatus === undefined) return [];
  const servers = yield* query.mcpServerStatus.pipe(
    Effect.flatMap(decodeMcpServerStatuses),
    Effect.repeat({
      until: (statuses) => statuses.every((server) => server.status !== "pending"),
      schedule: Schedule.spaced("250 millis"),
      times: 20,
    }),
  );
  const allow = servers.flatMap((server) =>
    server.status !== "connected"
      ? []
      : (server.tools ?? [])
          .filter((tool) => tool.annotations?.readOnly === true)
          .map((tool) =>
            tool.name.startsWith("mcp__")
              ? tool.name
              : `mcp__${mcpRuleName(server.name)}__${mcpRuleName(tool.name)}`,
          ),
  );
  if (allow.length > 0) yield* query.applyFlagSettings({ permissions: { allow } });
  return allow;
});

export interface ClaudeAskOnlyToolGuard {
  readonly hooks: NonNullable<ClaudeQueryOptions["hooks"]>;
  readonly allow: (tools: ReadonlyArray<string>) => void;
}

export function claudeAskOnlyToolGuard(
  turn: Pick<ClaudePolicyTurn, "appThread">,
  allowedTools: ReadonlyArray<string>,
): ClaudeAskOnlyToolGuard | undefined {
  if (!isAskOnlyTurn(turn)) return undefined;
  const allowed = new Set([...CLAUDE_READ_ONLY_ALLOWED_TOOLS, "ToolSearch", ...allowedTools]);
  const guard: HookCallback = (hookInput) =>
    Promise.resolve(
      hookInput.hook_event_name === "PreToolUse" && !allowed.has(hookInput.tool_name)
        ? {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason:
                "This is a read-only copy of the thread; it can read but not act.",
            },
          }
        : {},
    );
  return {
    hooks: { PreToolUse: [{ hooks: [guard] }] },
    allow: (tools) => {
      for (const tool of tools) allowed.add(tool);
    },
  };
}

export const claudeTurnUsesReadOnlyMcpTools = (turn: ClaudePolicyTurn): boolean =>
  isAskOnlyTurn(turn) || sandboxPolicyKindForClaudeRuntimePolicy(turn.runtimePolicy) === "readOnly";

export function claudeAskOnlyEnvironment(
  environment: NodeJS.ProcessEnv,
  appThread: Pick<ClaudePolicyTurn["appThread"], "id" | "lineage">,
): NodeJS.ProcessEnv {
  return appThread.lineage.askOnly === true
    ? { ...environment, [RAILS_ASK_ONLY_ENV]: appThread.id }
    : environment;
}

export function claudeTurnPermissionDenials(
  result: SDKResultMessage | undefined,
): Pick<OrchestrationV2ProviderTurn, "permissionDenials"> {
  const denials = result?.permission_denials ?? [];
  return denials.length === 0
    ? {}
    : {
        permissionDenials: denials.map((denial) => ({
          toolName: denial.tool_name,
          toolUseId: denial.tool_use_id,
        })),
      };
}
