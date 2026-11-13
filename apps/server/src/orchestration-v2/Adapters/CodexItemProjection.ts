import type { OrchestrationV2ExecutionNode, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { MCP_APP_RESOURCE_SCHEME } from "@t3tools/shared/mcpApp";
import { MCP_APP_CARD_OUTPUT_KEY, mcpAppCardFromMeta } from "@t3tools/shared/mcpAppCard";
import { mcpToolResultOutput } from "@t3tools/shared/toolOutput";
import type * as CodexSchema from "effect-codex-app-server/schema";

type CodexThreadItem =
  | CodexSchema.V2ItemStartedNotification__ThreadItem
  | CodexSchema.V2ItemCompletedNotification__ThreadItem;

export function codexItemStatus(status: "inProgress" | "completed" | "failed" | "declined"): {
  readonly node: OrchestrationV2ExecutionNode["status"];
  readonly turnItem: OrchestrationV2TurnItem["status"];
  readonly completed: boolean;
} {
  switch (status) {
    case "inProgress":
      return { node: "running", turnItem: "running", completed: false };
    case "completed":
      return {
        node: "completed",
        turnItem: "completed",
        completed: true,
      };
    case "failed":
      return { node: "failed", turnItem: "failed", completed: true };
    case "declined":
      return {
        node: "cancelled",
        turnItem: "cancelled",
        completed: true,
      };
  }
}

export function codexMcpToolOutput(
  item: Extract<CodexThreadItem, { readonly type: "mcpToolCall" }>,
): unknown | undefined {
  const resultOutput =
    item.result === null || item.result === undefined
      ? undefined
      : mcpToolResultOutput(item.result);

  if (item.error === null || item.error === undefined) {
    const card = mcpAppCardFromMeta(item.result?._meta);
    return card === undefined
      ? resultOutput
      : { [MCP_APP_CARD_OUTPUT_KEY]: card, result: resultOutput };
  }
  return resultOutput === undefined
    ? { error: item.error.message }
    : { error: item.error.message, result: resultOutput };
}

export function codexMcpAppResourceUri(item: CodexThreadItem): string | undefined {
  if (item.type !== "mcpToolCall") return undefined;
  const uri = item.mcpAppUi?.resourceUri ?? item.mcpAppResourceUri ?? item.appContext?.resourceUri;
  return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) ? uri : undefined;
}
