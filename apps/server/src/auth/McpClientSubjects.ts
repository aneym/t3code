import type { AuthMcpClientAccess, AuthSessionId } from "@t3tools/contracts";

const MCP_CLIENT_SUBJECT = "mcp-client";
const OWNER_CLI_SUBJECT = "mcp-client-owner-cli";

export interface McpClientSession {
  readonly sessionId: AuthSessionId;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  readonly peerLink: boolean;
  readonly ownerCli: boolean;
}

export const isMcpClientSubject = (subject: string) =>
  subject === MCP_CLIENT_SUBJECT || subject === OWNER_CLI_SUBJECT;

export const isOwnerCliSubject = (subject: string) => subject === OWNER_CLI_SUBJECT;

export const mcpClientSubject = (ownerCli: boolean | undefined) =>
  ownerCli === true ? OWNER_CLI_SUBJECT : MCP_CLIENT_SUBJECT;
