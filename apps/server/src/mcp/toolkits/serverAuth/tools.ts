import {
  OrchestratorMcpFailure,
  ServerAuthIssuedSession,
  ServerAuthSessionIssueInput,
  ServerAuthSessionList,
  ServerAuthSessionRevokeInput,
  ServerAuthSessionRevokeResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, EnvironmentAuth.EnvironmentAuth],
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

export const ServerAuthToolkit = Toolkit.make(SessionIssueTool, SessionListTool, SessionRevokeTool);
