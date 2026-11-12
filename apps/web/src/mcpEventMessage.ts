import type { McpEventMessageSource } from "@t3tools/contracts";

export function mcpEventLabel(event: Partial<McpEventMessageSource>): string {
  return event.name === undefined
    ? "from an MCP server"
    : `${event.name} from ${event.server ?? "an MCP server"}`;
}
