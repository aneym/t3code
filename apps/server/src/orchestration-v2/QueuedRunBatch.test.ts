import { describe, expect, it } from "vite-plus/test";

import { queuedRunBatch } from "./QueuedRunBatch.ts";

const sonnet = { instanceId: "claudeAgent", model: "claude-sonnet-5-5" };
const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };

function queue(
  entries: ReadonlyArray<{
    readonly id: string;
    readonly text?: string;
    readonly completion?: boolean;
    readonly held?: boolean;
    readonly model?: typeof sonnet;
  }>,
) {
  return {
    messages: entries.map((entry) => ({
      id: `message:${entry.id}`,
      text: entry.text ?? entry.id,
      attachments: [],
      ...(entry.completion
        ? {
            createdBy: "agent",
            creationSource: "server",
            delegatedCompletion: { generation: 1, parentRunId: "run:parent", taskIds: ["task"] },
          }
        : { createdBy: "user", creationSource: "web" }),
    })),
    runs: entries.map((entry, index) => ({
      id: `run:${entry.id}`,
      ordinal: index + 10,
      queuePosition: index + 1,
      status: "queued",
      userMessageId: `message:${entry.id}`,
      providerInstanceId: (entry.model ?? sonnet).instanceId,
      modelSelection: entry.model ?? sonnet,
      ...(entry.held ? { queueHeld: true, queueHoldReason: "blocked" } : {}),
    })),
  } as never;
}

function batchIds(projection: ReturnType<typeof queue>, head: string) {
  const first = (projection as { runs: ReadonlyArray<{ id: string }> }).runs.find(
    (run) => run.id === `run:${head}`,
  );
  return queuedRunBatch(projection, first as never).map(({ run }) => run.id);
}

describe("queued run batch", () => {
  it.each([
    {
      name: "completion deliveries share the turn and incompatible runs do not block later ones",
      entries: [
        { id: "user-1" },
        { id: "other-model", model: opus },
        { id: "completion-1", completion: true },
        { id: "agent-send" },
        { id: "completion-2", completion: true },
        { id: "held", held: true },
        { id: "user-2" },
      ],
      head: "completion-1",
      expected: ["run:completion-2", "run:user-1", "run:agent-send", "run:user-2"],
    },
    {
      name: "a queued command keeps later messages behind it",
      entries: [
        { id: "user-1" },
        { id: "other-model", model: opus },
        { id: "user-2" },
        { id: "compact", text: "/compact" },
        { id: "user-3" },
      ],
      head: "user-1",
      expected: ["run:user-2"],
    },
  ])("$name", ({ entries, head, expected }) => {
    expect(batchIds(queue(entries), head)).toEqual(expected);
  });
});
