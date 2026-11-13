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
    description: "List agent homes and their main thread and office bindings.",
    success: AgentHomesSnapshot,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_agent_bind", {
    ...shared,
    description:
      "Bind an agent home to a main thread, preserving the previous binding. With `office`, bind the thread as the office where agent traffic lands; the main thread and its pin stay as they are, and the office is unpinned.",
    parameters: AgentBindInput,
    success: AgentBindResult,
  }).annotate(Tool.Destructive, true),
);
