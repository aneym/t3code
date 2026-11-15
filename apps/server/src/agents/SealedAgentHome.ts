// @effect-diagnostics nodeBuiltinImport:off -- the agent home's own files are the boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { agentHomeOfPath } from "./AgentHomeOfPath.ts";
import { parseDocument, readDocumentText } from "./AgentHomeFiles.ts";
import { agentHomeSealing } from "./AgentHomeSealing.ts";

export interface SealedAgentHome {
  readonly home: string;
  readonly mcpServers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

const isServer = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (typeof (value as Record<string, unknown>).command === "string" ||
    typeof (value as Record<string, unknown>).url === "string");

const readMcpServers = async (home: string) => {
  const file = NodePath.join(home, "mcp.json");
  const servers = await NodeFSP.lstat(file)
    .then(async (stat) =>
      stat.isFile() ? parseDocument(await NodeFSP.readFile(file, "utf8")).mcpServers : null,
    )
    .catch(() => null);
  return typeof servers === "object" && servers !== null && !Array.isArray(servers)
    ? Object.fromEntries(Object.entries(servers).filter(([, server]) => isServer(server)))
    : {};
};

export const sealedAgentHomeFor = async (cwd: string | null): Promise<SealedAgentHome | null> => {
  const location = await agentHomeOfPath(cwd);
  if (location === null) return null;
  const { root, handle, home } = location;
  const text = await readDocumentText(root, handle).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new Error(
      `T3 Code could not read ${home}/agent.json, so it can't tell whether this agent home is sealed.`,
    );
  });
  if (text === null) return null;
  const doc = (() => {
    try {
      return parseDocument(text);
    } catch {
      throw new Error(
        `${home}/agent.json is not valid JSON, so T3 Code can't tell whether this agent home is sealed.`,
      );
    }
  })();
  const sealing = agentHomeSealing(doc);
  if (sealing === "invalid")
    throw new Error(
      `${home}/agent.json has a "sealed" value that is not true or false, so T3 Code can't tell whether this agent home is sealed.`,
    );
  return sealing === "sealed" ? { home, mcpServers: await readMcpServers(home) } : null;
};
