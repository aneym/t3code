import { ORCHESTRATOR_MCP_RUNNING_TASK_NEXT, RunId } from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import type { McpToolUseCase } from "./run.ts";

export function withRestartNotice(testCase: McpToolUseCase): McpToolUseCase {
  testCase = {
    ...testCase,
    prompt: testCase.prompt.replace("{{runningTaskNext}}", ORCHESTRATOR_MCP_RUNNING_TASK_NEXT),
  };
  if (!testCase.id.startsWith("restart-declined-")) return testCase;
  const summary = subagentResultForRun(
    { messages: [], turnItems: [] },
    { id: RunId.make("run:child:1"), status: "cancelled", restartDeclined: "provider_disabled" },
  ).text;
  return {
    ...testCase,
    prompt: testCase.prompt.replace("{{restartNotice}}", summary),
  };
}
