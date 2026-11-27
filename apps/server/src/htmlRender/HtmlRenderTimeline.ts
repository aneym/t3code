import { OrchestratorMcpFailure, TurnItemId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import {
  HTML_RENDER_TOOL_NAME,
  readHtmlRenderReference,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  parseAttachmentFileExtension,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import type { McpThreadCaller } from "../mcp/McpInvocationContext.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const attachFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Could not attach the HTML page to this chat. Include its key points in your reply.",
  });

interface RenderInvocation {
  readonly attach: (page: HtmlRenderReference) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly reportFailure: Effect.Effect<void, OrchestratorMcpFailure>;
}

export const HtmlRenderTimeline = Context.Reference<
  | {
      readonly begin: (
        caller: McpThreadCaller,
      ) => Effect.Effect<RenderInvocation | undefined, OrchestratorMcpFailure>;
    }
  | undefined
>("t3/htmlRender/HtmlRenderTimeline", { defaultValue: () => undefined });

export const layer = Layer.effect(
  HtmlRenderTimeline,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventSink.EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const sessions = yield* McpProviderSessions.McpProviderSessions;

    const begin = Effect.fn("HtmlRenderTimeline.begin")(function* (caller: McpThreadCaller) {
      const instance = yield* instances.getInstance(caller.providerInstanceId);
      if (instance?.driverKind !== "antigravity") return undefined;
      const { threadId, providerInstanceId } = caller;
      const session = yield* sessions.read(threadId);
      if (session?.providerSessionId !== caller.providerSessionId) return yield* attachFailure();
      const { run, providerThread, providerTurn } = yield* projections
        .getRunningTurnContext(threadId)
        .pipe(Effect.mapError(attachFailure));
      if (
        run?.activeAttemptId == null ||
        run.rootNodeId === null ||
        run.providerInstanceId !== providerInstanceId ||
        providerThread?.driver !== "antigravity"
      ) {
        return yield* attachFailure();
      }
      const { id: runId, activeAttemptId, rootNodeId: nodeId } = run;

      const write = Effect.fn("HtmlRenderTimeline.write")(function* (page?: HtmlRenderReference) {
        const occurredAt = yield* DateTime.now;
        const id = yield* ids.allocate.event({ threadId }).pipe(Effect.mapError(attachFailure));
        const { committed } = yield* events
          .writeIfRunCurrent({
            threadId,
            runId,
            activeAttemptId,
            expectedStatus: "running",
            events: [
              {
                id,
                threadId,
                runId,
                nodeId,
                driver: providerThread.driver,
                providerInstanceId,
                occurredAt,
                type: "turn-item.updated",
                payload: {
                  id: TurnItemId.make(id),
                  threadId,
                  runId,
                  nodeId,
                  providerThreadId: providerThread.id,
                  providerTurnId: providerTurn?.id ?? null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 0,
                  title: null,
                  startedAt: occurredAt,
                  completedAt: occurredAt,
                  updatedAt: occurredAt,
                  ...(page === undefined
                    ? {
                        type: "notification" as const,
                        status: "failed" as const,
                        source: { kind: "system" as const },
                        outcome: "failed" as const,
                        summary: "Could not attach the HTML page to this chat.",
                      }
                    : {
                        type: "dynamic_tool" as const,
                        status: "completed" as const,
                        ...mcpToolPresentation({
                          serverName: "t3-code",
                          toolName: HTML_RENDER_TOOL_NAME,
                        }),
                        toolName: `t3-code.${HTML_RENDER_TOOL_NAME}`,
                        input: { title: page.title },
                        output: { htmlRender: page },
                      }),
                },
              },
            ],
          })
          .pipe(Effect.mapError(attachFailure));
        if (!committed) return yield* attachFailure();
      });

      return {
        attach: (page) => {
          const reference = readHtmlRenderReference(page);
          return reference !== undefined &&
            parseAttachmentFileExtension(reference.attachmentId) === "html" &&
            parseThreadSegmentFromAttachmentId(reference.attachmentId) ===
              toSafeThreadAttachmentSegment(threadId)
            ? sessions
                .takeHtmlRender(threadId, {}, reference)
                .pipe(Effect.andThen(write(reference)))
            : Effect.fail(attachFailure());
        },
        reportFailure: write(),
      } satisfies RenderInvocation;
    });

    return { begin };
  }),
);
