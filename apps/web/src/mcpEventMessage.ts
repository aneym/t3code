const MCP_EVENT_HEAD = /^MCP event `([^`]{1,80})` from ([^\s(]{1,120})/;

export interface McpEventHead {
  readonly name: string;
  readonly from: string;
}

export function mcpEventHeadOf(text: string): McpEventHead | null {
  const hit = MCP_EVENT_HEAD.exec(text);
  return hit ? { name: hit[1]!, from: hit[2]! } : null;
}

export function queuedMcpEventOf(
  message: { readonly createdBy?: string | undefined; readonly text: string } | undefined,
): McpEventHead | null {
  return message?.createdBy === "system" ? mcpEventHeadOf(message.text) : null;
}
