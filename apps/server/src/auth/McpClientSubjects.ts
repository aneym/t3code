import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type { VerifiedSession } from "./SessionStore.ts";
import type { AuthMcpClientAccess, AuthSessionId, PeerIdentity } from "@t3tools/contracts";

const MCP_CLIENT_SUBJECT = "mcp-client";
const OWNER_CLI_SUBJECT = "mcp-client-owner-cli";

export interface McpClientSession {
  readonly sessionId: AuthSessionId;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  readonly peerLink: boolean;
  readonly peer?: PeerIdentity | undefined;
  readonly ownerCli: boolean;
}

export const isMcpClientSubject = (subject: string) =>
  subject === MCP_CLIENT_SUBJECT || subject === OWNER_CLI_SUBJECT;

const isOwnerCliSubject = (subject: string) => subject === OWNER_CLI_SUBJECT;

export const mcpClientSubject = (ownerCli: boolean | undefined) =>
  ownerCli === true ? OWNER_CLI_SUBJECT : MCP_CLIENT_SUBJECT;

export const mcpClientSession = (session: VerifiedSession): McpClientSession => ({
  sessionId: session.sessionId,
  label: session.client.label ?? "MCP client",
  access: session.scopes.includes(AuthOrchestrationOperateScope)
    ? (session.runtimeModeCeiling ?? "approval-required")
    : "read-only",
  peerLink: session.peerLink === true,
  ownerCli: isOwnerCliSubject(session.subject),
  peer: session.peer,
});
