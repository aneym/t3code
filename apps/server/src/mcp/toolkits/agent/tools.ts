import {
  AgentBindInput,
  AgentBindResult,
  AgentHomesSnapshot,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import { AgentHomeService } from "../../../agents/AgentHomeService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [AgentHomeService, McpInvocationContext, ThreadManagementService],
};
export const AgentToolkit = Toolkit.make(
  Tool.make("t3_agent_list", {
    ...shared,
    description: "List agent homes and their main thread bindings.",
    success: AgentHomesSnapshot,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_agent_bind", {
    ...shared,
    description:
      "Bind an agent home to a main thread (the previous binding is kept) and/or set the projects it owns; zooming the agent in the sidebar shows those projects.",
    parameters: AgentBindInput,
    success: AgentBindResult,
  }).annotate(Tool.Destructive, true),
);
