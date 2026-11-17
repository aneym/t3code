import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { claudeMcpToolPrefix } from "@t3tools/shared/mcpApp";

interface ClaudeRule {
  readonly behavior: string;
  readonly rule: string;
  readonly notInEffect?: boolean | undefined;
}

const LOCAL_TRANSPORTS = new Set(["stdio", "http", "sse", "sdk"]);

function ownsItsName(status: McpServerStatus | undefined): boolean {
  const config = status?.config;
  if (config === undefined || "sessionProxied" in status!) return false;
  const type = "type" in config ? config.type : undefined;
  return type === undefined ? "command" in config : LOCAL_TRANSPORTS.has(type);
}

export function claudeRulesMayCoverMcpTool(
  rules: ReadonlyArray<ClaudeRule>,
  behaviors: ReadonlyArray<string>,
  status: McpServerStatus | undefined,
  server: string,
): boolean {
  const scoped = ownsItsName(status);
  const segment = claudeMcpToolPrefix(server).slice("mcp__".length).split("__", 1)[0];
  return rules.some((entry) => {
    if (!behaviors.includes(entry.behavior) || entry.notInEffect === true) return false;
    const name = entry.rule.split("(", 1)[0] ?? entry.rule;
    if (name.includes("*")) return true;
    if (!name.startsWith("mcp__")) return false;
    return !scoped || name.slice("mcp__".length).split("__", 1)[0] === segment;
  });
}
