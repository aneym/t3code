import { describe, expect, it } from "vite-plus/test";

import { queuedRunBatchEvents } from "./QueuedRunBatch.ts";

const sender = {
  senderThreadId: "thread:lead",
  senderEnvironmentId: "env:rails",
  senderEnvironmentLabel: "Rails",
  linkedSender: { environmentId: "env:rails", threadId: "thread:lead", title: "Lead" },
};

const queued = (id: string) => ({
  run: { id: `run:${id}`, threadId: "thread:target", providerInstanceId: "codex" },
  message: {
    id: `message:${id}`,
    text: id,
    attachments: [],
    createdBy: "agent",
    creationSource: "mcp",
    ...sender,
  },
});

describe("queued run batch events", () => {
  it("keeps each folded agent message's sender over the first message's", () => {
    const events = queuedRunBatchEvents({
      members: [queued("second"), queued("third")],
      projection: { nodes: [], attempts: [] },
      target: { id: "run:first", threadId: "thread:target", providerInstanceId: "codex" },
      rootNodeId: "node:first",
      firstItem: {
        id: "item:first",
        type: "user_message",
        ordinal: 100,
        messageId: "message:first",
        text: "first",
        attachments: [],
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: "thread:other",
        linkedSender: { environmentId: "env:other", threadId: "thread:other", title: "Other" },
      },
      itemId: (messageId: string) => `item:${messageId}`,
      occurredAt: "2026-11-19T00:00:00.000Z",
    } as never);

    expect(
      events.flatMap((event) => (event.type === "turn-item.updated" ? [event.payload] : [])),
    ).toEqual([
      expect.objectContaining({ messageId: "message:second", createdBy: "agent", ...sender }),
      expect.objectContaining({ messageId: "message:third", createdBy: "agent", ...sender }),
    ]);
  });
});
