import { agentHomeOfPath } from "./AgentHomeOfPath.ts";
import { homeFromDocument, parseDocument, readDocumentText } from "./AgentHomeFiles.ts";

const RAILS_AGENT_ID_PATTERN = /^[0-9a-f]{12}$/;

export const railsAgentIdOfPath = async (cwd: string | null | undefined) => {
  const location = await agentHomeOfPath(cwd ?? null);
  if (location === null) return undefined;
  try {
    const doc = parseDocument(await readDocumentText(location.root, location.handle));
    const id = homeFromDocument(location.root, location.handle, doc).railsAgentId;
    return id !== undefined && RAILS_AGENT_ID_PATTERN.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
};
