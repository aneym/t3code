import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  MCP_APP_CARD_OUTPUT_KEY,
  mcpAppCardFromMeta,
  mcpAppCardFromOutput,
} from "@t3tools/shared/mcpAppCard";
import * as Predicate from "effect/Predicate";

import { stripUnservedToolOutputImageBytes } from "./toolOutputImageBytes.ts";
import { boundFileChangeForStorage } from "./WireProjection.ts";

function stampMcpAppCard(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "dynamic_tool" || !Predicate.isObject(item.output)) return item;
  const output = item.output;
  if (mcpAppCardFromOutput(output) !== undefined) return item;
  const card =
    mcpAppCardFromMeta(output._meta) ??
    (Predicate.isObject(output.result) ? mcpAppCardFromMeta(output.result._meta) : undefined);
  return card === undefined
    ? item
    : { ...item, output: { ...output, [MCP_APP_CARD_OUTPUT_KEY]: card } };
}

export function prepareTurnItemForStorage(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  return boundFileChangeForStorage(stampMcpAppCard(stripUnservedToolOutputImageBytes(item)));
}
