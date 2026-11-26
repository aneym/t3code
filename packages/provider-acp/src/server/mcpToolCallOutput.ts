import type { ThreadId } from "@t3tools/contracts";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  compactDynamicToolOutput,
  htmlRenderFromToolItem,
  mcpToolResultOutput,
} from "@t3tools/shared/toolOutput";
import * as Effect from "effect/Effect";

import { unknownRecord } from "./clientPolicy.ts";
import type { AcpToolCallState } from "./runtimeModel.ts";

export function acpMcpToolCallOutput(rawOutput: unknown): unknown {
  const record = unknownRecord(rawOutput);
  if (record === undefined) return rawOutput;
  if (!("result" in record) && !("error" in record)) return rawOutput;
  const result = unknownRecord(record.result);
  const resultOutput = result === undefined ? undefined : mcpToolResultOutput(result);
  const errorMessage = unknownRecord(record.error)?.message;
  if (typeof errorMessage !== "string") return resultOutput ?? rawOutput;
  return resultOutput === undefined
    ? { error: errorMessage }
    : { error: errorMessage, result: resultOutput };
}

export const recoverAcpHtmlRender = Effect.fn("recoverAcpHtmlRender")(function* (options: {
  readonly sessions: McpProviderSessions.McpProviderSessions["Service"];
  readonly threadId: ThreadId;
  readonly toolName: string;
  readonly status: string;
  readonly input: Record<string, unknown>;
  readonly output: unknown;
  readonly rawResult: unknown;
  readonly previous: AcpToolCallState | undefined;
}) {
  const { sessions, threadId, toolName, status, input, output, rawResult, previous } = options;
  const isError =
    compactDynamicToolOutput(output)?.isError === true ||
    compactDynamicToolOutput(rawResult)?.isError === true;
  const reportedPage = htmlRenderFromToolItem({ toolName, output });
  if (status === "failed" || (status === "completed" && isError)) {
    if (previous?.status !== "failed" && previous?.status !== "completed") {
      yield* sessions.takeHtmlRender(threadId, input, reportedPage);
    }
  } else if (status === "completed") {
    if (reportedPage !== undefined) {
      yield* sessions.takeHtmlRender(threadId, input, reportedPage);
    } else {
      const previousPage = htmlRenderFromToolItem({
        toolName,
        output: acpMcpToolCallOutput(previous?.data.rawOutput ?? previous?.data.content),
      });
      const page = previousPage ?? (yield* sessions.takeHtmlRender(threadId, input));
      if (page !== undefined) return { htmlRender: page };
    }
  }
  return undefined;
});
