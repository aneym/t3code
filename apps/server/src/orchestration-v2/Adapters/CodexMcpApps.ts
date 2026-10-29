import { MCP_APP_RESOURCE_SCHEME } from "@t3tools/shared/mcpApp";

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

export function codexMcpAppResourceUri(item: unknown): string | undefined {
  if (field(item, "type") !== "mcpToolCall") return undefined;
  const candidates = [
    field(field(field(field(item, "result"), "_meta"), "ui"), "resourceUri"),
    field(field(item, "mcpAppUi"), "resourceUri"),
    field(item, "mcpAppResourceUri"),
    field(field(item, "appContext"), "resourceUri"),
  ];
  return candidates.find(
    (uri): uri is string => typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME),
  );
}
