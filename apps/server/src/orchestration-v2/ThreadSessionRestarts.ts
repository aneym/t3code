import type { ThreadId } from "@t3tools/contracts";

export interface McpServerInventory {
  readonly name: string;
  readonly status: string;
  readonly tools: number;
}

export interface McpInventory {
  readonly servers: ReadonlyArray<McpServerInventory>;
}

interface ClaudeInitInventorySource {
  readonly mcp_servers?: ReadonlyArray<{ readonly name: string; readonly status: string }>;
  readonly tools?: ReadonlyArray<string>;
}

const TRACKED_THREAD_LIMIT = 1000;
const requested = new Set<ThreadId>();
const inventories = new Map<ThreadId, McpInventory>();
const pendingReports = new Map<ThreadId, McpInventory | null>();

const remember = <V>(map: Map<ThreadId, V>, threadId: ThreadId, value: V) => {
  map.delete(threadId);
  map.set(threadId, value);
  if (map.size > TRACKED_THREAD_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
};

export function requestThreadSessionRestart(threadId: ThreadId): void {
  requested.add(threadId);
  if (requested.size > TRACKED_THREAD_LIMIT) {
    const oldest = requested.values().next().value;
    if (oldest !== undefined) requested.delete(oldest);
  }
}

export function threadSessionRestartRequested(threadId: ThreadId): boolean {
  return requested.has(threadId);
}

export function takeThreadSessionRestart(threadId: ThreadId): boolean {
  if (!requested.delete(threadId)) return false;
  expectThreadSessionRestartReport(threadId);
  return true;
}

export function expectThreadSessionRestartReport(threadId: ThreadId): void {
  remember(pendingReports, threadId, inventories.get(threadId) ?? null);
}

export function readMcpInventory(threadId: ThreadId): McpInventory | null {
  return inventories.get(threadId) ?? null;
}

export function recordMcpInventory(threadId: ThreadId, inventory: McpInventory): string | null {
  remember(inventories, threadId, inventory);
  if (!pendingReports.has(threadId)) return null;
  const before = pendingReports.get(threadId) ?? null;
  pendingReports.delete(threadId);
  return describeSessionRestart(before, inventory);
}

const claudeToolPrefix = (serverName: string) =>
  `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;

export function claudeMcpInventory(message: ClaudeInitInventorySource): McpInventory {
  const tools = message.tools ?? [];
  return {
    servers: (message.mcp_servers ?? []).map((server) => {
      const prefix = claudeToolPrefix(server.name);
      return {
        name: server.name,
        status: server.status,
        tools: tools.filter((tool) => tool.startsWith(prefix)).length,
      };
    }),
  };
}

const toolCount = (tools: number) => `${tools} ${tools === 1 ? "tool" : "tools"}`;

const describeServer = (server: McpServerInventory) =>
  server.status === "connected"
    ? `${server.name} ${toolCount(server.tools)}`
    : `${server.name} ${server.status}`;

function describeSessionRestart(before: McpInventory | null, after: McpInventory): string {
  const lead = "Session restarted with fresh MCP servers and settings.";
  if (after.servers.length === 0 && (before?.servers.length ?? 0) === 0) {
    return `${lead} No MCP servers.`;
  }
  if (before === null) {
    return `${lead} MCP: ${after.servers.map(describeServer).join(", ")}.`;
  }
  const previous = new Map(before.servers.map((server) => [server.name, server]));
  const changes: Array<string> = [];
  let unchanged = 0;
  for (const server of after.servers) {
    const old = previous.get(server.name);
    previous.delete(server.name);
    if (old === undefined) {
      changes.push(`${describeServer(server)} (new)`);
    } else if (old.status !== server.status) {
      const now = server.status === "connected" ? toolCount(server.tools) : server.status;
      changes.push(`${server.name} ${old.status} → ${now}`);
    } else if (old.tools !== server.tools) {
      changes.push(`${server.name} ${old.tools} → ${toolCount(server.tools)}`);
    } else {
      unchanged += 1;
    }
  }
  for (const removed of previous.values()) changes.push(`${removed.name} removed`);
  const tail =
    unchanged === 0
      ? ""
      : changes.length === 0
        ? `All ${unchanged} MCP servers unchanged.`
        : `${unchanged} other ${unchanged === 1 ? "server" : "servers"} unchanged.`;
  return [lead, changes.length === 0 ? "" : `MCP: ${changes.join(", ")}.`, tail]
    .filter((part) => part.length > 0)
    .join(" ");
}
