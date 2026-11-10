import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import type * as ServerSettings from "../../serverSettings.ts";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";

type StreamEvent = SDKPartialAssistantMessage["event"];

interface TurnTextBlocks {
  readonly byIndex: Map<number, string>;
  readonly started: Map<string, number>;
  readonly pending: Map<string, Array<string>>;
}

const STREAM_FLUSH_INTERVAL_MS = 100;

export function buildAssistantArtifacts(input: {
  readonly driver: ProviderDriverKind;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nativeItemId: string;
  readonly text: string;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc;
}): {
  readonly node: OrchestrationV2ExecutionNode;
  readonly message: OrchestrationV2ConversationMessage;
  readonly turnItem: OrchestrationV2TurnItem;
} {
  const nodeId = input.idAllocator.derive.nodeFromProviderItem({
    driver: input.driver,
    nativeItemId: input.nativeItemId,
  });
  const messageId = input.idAllocator.derive.messageFromProviderItem({
    driver: input.driver,
    nativeItemId: input.nativeItemId,
  });
  const turnItemId = input.idAllocator.derive.turnItemFromProviderItem({
    driver: input.driver,
    nativeItemId: input.nativeItemId,
  });
  const nativeItemRef = {
    driver: input.driver,
    nativeId: input.nativeItemId,
    strength: "strong" as const,
  };

  return {
    node: {
      id: nodeId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      parentNodeId: input.turnInput.rootNodeId,
      rootNodeId: input.turnInput.rootNodeId,
      kind: "assistant_message",
      status: "completed",
      countsForRun: false,
      providerThreadId: input.turnInput.providerThread.id,
      providerTurnId: input.providerTurnId,
      nativeItemRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    },
    message: {
      createdBy: "agent",
      creationSource: "provider",
      id: messageId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      nodeId,
      role: "assistant",
      text: input.text,
      attachments: [],
      streaming: false,
      createdAt: input.completedAt,
      updatedAt: input.completedAt,
    },
    turnItem: {
      id: turnItemId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      nodeId,
      providerThreadId: input.turnInput.providerThread.id,
      providerTurnId: input.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal: input.ordinal,
      status: "completed",
      title: null,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      updatedAt: input.completedAt,
      type: "assistant_message",
      messageId,
      text: input.text,
      streaming: false,
    },
  };
}

export function assistantTextEvents(
  driver: ProviderDriverKind,
  artifacts: ReturnType<typeof buildAssistantArtifacts>,
  completed: boolean,
): ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> {
  const { node, message, turnItem } = artifacts;
  if (completed)
    return [
      { type: "node.updated", driver, node },
      { type: "message.updated", driver, message },
      { type: "turn_item.updated", driver, turnItem },
    ];
  if (turnItem.type !== "assistant_message") return [];
  return [
    { type: "node.updated", driver, node: { ...node, status: "running", completedAt: null } },
    {
      type: "turn_item.updated",
      driver,
      turnItem: { ...turnItem, status: "running", streaming: true, completedAt: null },
    },
  ];
}

export const makeClaudeAssistantTextStream = Effect.fn("makeClaudeAssistantTextStream")(
  function* (input: {
    readonly serverSettings: Option.Option<ServerSettings.ServerSettingsService["Service"]>;
    readonly emit: (update: ProviderTextDeltaUpdate) => Effect.Effect<void>;
  }): Effect.fn.Return<
    {
      readonly observe: (
        turnId: string,
        messageId: string | null,
        event: StreamEvent,
      ) => Effect.Effect<void>;
      readonly takeSnapshotKey: (
        turnId: string,
        messageId: string,
      ) => Effect.Effect<string | undefined>;
      readonly flushTurn: (turnId: string) => Effect.Effect<void>;
    },
    never,
    Scope.Scope
  > {
    const turns = new Map<string, TurnTextBlocks>();
    const deltas = yield* makeProviderTextDeltaCoalescer({
      flushIntervalMs: STREAM_FLUSH_INTERVAL_MS,
      emit: input.emit,
    });
    const enabled = Option.match(input.serverSettings, {
      onNone: () => Effect.succeed(false),
      onSome: (settings) =>
        settings.getSettings.pipe(
          Effect.map((current) => current.liveThreadFeed),
          Effect.orElseSucceed(() => false),
        ),
    });
    const blocksFor = (turnId: string) => {
      const existing = turns.get(turnId);
      if (existing !== undefined) return existing;
      const created: TurnTextBlocks = {
        byIndex: new Map(),
        started: new Map(),
        pending: new Map(),
      };
      turns.set(turnId, created);
      return created;
    };

    const observe = Effect.fnUntraced(function* (
      turnId: string,
      messageId: string | null,
      event: StreamEvent,
    ) {
      if (event.type === "message_start") {
        turns.get(turnId)?.byIndex.clear();
        return;
      }
      if (messageId === null) return;
      if (event.type === "content_block_start") {
        if (event.content_block.type !== "text" || !(yield* enabled)) return;
        const blocks = blocksFor(turnId);
        const count = blocks.started.get(messageId) ?? 0;
        blocks.started.set(messageId, count + 1);
        const itemId = `${messageId}:text:${count}`;
        blocks.byIndex.set(event.index, itemId);
        blocks.pending.set(messageId, [...(blocks.pending.get(messageId) ?? []), itemId]);
        yield* deltas.append({ turnId, itemId, delta: event.content_block.text });
        return;
      }
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        const itemId = turns.get(turnId)?.byIndex.get(event.index);
        if (itemId !== undefined) yield* deltas.append({ turnId, itemId, delta: event.delta.text });
      }
    });

    const takeSnapshotKey = Effect.fnUntraced(function* (turnId: string, messageId: string) {
      const pending = turns.get(turnId)?.pending.get(messageId);
      const itemId = pending?.shift();
      if (itemId === undefined) return undefined;
      yield* deltas.complete({ turnId, itemId, finalText: "", emitEmpty: false });
      return itemId;
    });

    const flushTurn = Effect.fnUntraced(function* (turnId: string) {
      if (!turns.has(turnId)) return;
      yield* deltas.flushTurn(turnId);
      turns.delete(turnId);
    });

    return { observe, takeSnapshotKey, flushTurn };
  },
);
