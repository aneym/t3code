import {
  OrchestratorMcpFailure,
  ServerAuthIssuedSession,
  ServerAuthPairingCreateInput,
  ServerAuthPairingLink,
  ServerAuthPairingList,
  ServerAuthPairingRevokeInput,
  ServerAuthSessionIssueInput,
  ServerAuthSessionList,
  ServerAuthSessionRevokeInput,
  ServerAuthSessionRevokeResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as ChatThreadSets from "../../../chatSession/ChatThreadSets.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    EnvironmentAuth.EnvironmentAuth,
    ChatThreadSets.ChatThreadSets,
  ],
};

const SessionIssueTool = Tool.make("t3_auth_session_issue", {
  ...shared,
  description: "Owner CLI only. Issue a scoped bearer session on this server.",
  parameters: ServerAuthSessionIssueInput,
  success: ServerAuthIssuedSession,
}).annotate(Tool.Destructive, false);

const SessionListTool = Tool.make("t3_auth_session_list", {
  ...shared,
  description: "Owner CLI only. List this server's active sessions without their tokens.",
  success: ServerAuthSessionList,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SessionRevokeTool = Tool.make("t3_auth_session_revoke", {
  ...shared,
  description: "Owner CLI only. Revoke one of this server's sessions.",
  parameters: ServerAuthSessionRevokeInput,
  success: ServerAuthSessionRevokeResult,
}).annotate(Tool.Destructive, true);

const PairingCreateTool = Tool.make("t3_auth_pairing_create", {
  ...shared,
  description:
    "Owner CLI only. Create a one-time pairing link on this server; chatThreadIds makes it chat-only.",
  parameters: ServerAuthPairingCreateInput,
  success: ServerAuthPairingLink,
}).annotate(Tool.Destructive, false);

const PairingListTool = Tool.make("t3_auth_pairing_list", {
  ...shared,
  description: "Owner CLI only. List this server's active pairing links without their secrets.",
  success: ServerAuthPairingList,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PairingRevokeTool = Tool.make("t3_auth_pairing_revoke", {
  ...shared,
  description: "Owner CLI only. Revoke one of this server's pairing links.",
  parameters: ServerAuthPairingRevokeInput,
  success: ServerAuthSessionRevokeResult,
}).annotate(Tool.Destructive, true);

export const ServerAuthToolkit = Toolkit.make(
  SessionIssueTool,
  SessionListTool,
  SessionRevokeTool,
  PairingCreateTool,
  PairingListTool,
  PairingRevokeTool,
);
