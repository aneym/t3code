import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import type { VerifiedSession } from "./SessionStore.ts";
import type { AuthMcpClientAccess, AuthSessionId, PeerIdentity } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

const MCP_CLIENT_SUBJECT = "mcp-client";
const OWNER_CLI_SUBJECT = "mcp-client-owner-cli";
export const HOST_DAEMON_SUBJECT = "host-daemon";
export const HostDaemonScopes = [AuthOrchestrationReadScope, AuthDiagnosticsReadScope] as const;

export interface McpClientSession {
  readonly sessionId: AuthSessionId;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
  readonly peerLink: boolean;
  readonly peer?: PeerIdentity | undefined;
  readonly ownerCli: boolean;
  readonly expiresAt?: DateTime.DateTime | undefined;
}

export const isMcpClientSubject = (subject: string) =>
  subject === MCP_CLIENT_SUBJECT || subject === OWNER_CLI_SUBJECT;

const isHostDaemonSession = (session: VerifiedSession) =>
  session.subject === HOST_DAEMON_SUBJECT &&
  session.method === "bearer-access-token" &&
  session.scopes.every((scope) => (HostDaemonScopes as ReadonlyArray<string>).includes(scope));

export const isAcceptedOnMcp = (session: VerifiedSession) =>
  (isMcpClientSubject(session.subject) && session.method === "bearer-access-token") ||
  isHostDaemonSession(session);

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
  expiresAt: session.expiresAt,
});
