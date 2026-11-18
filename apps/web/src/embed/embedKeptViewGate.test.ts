import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import {
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { keptTailSnapshot } from "./embedKeptTail";
import {
  embedConnectionRefused,
  embedKeptView,
  type EmbedKeptViewInput,
} from "./embedKeptViewGate";

const NOW = DateTime.makeUnsafe("2026-11-18T00:00:00.000Z");

const seen = ThreadId.make("thread-seen");
const other = ThreadId.make("thread-other");
const sessionSees = { chatSession: { ownerThreadIds: [], threadIds: [seen] } };

const base: EmbedKeptViewInput = {
  threadId: seen,
  status: "cached",
  hasData: true,
  chatSession: true,
  liveConfig: sessionSees,
};

describe("embedKeptView", () => {
  it.each<[string, Partial<EmbedKeptViewInput>, ReturnType<typeof embedKeptView>]>([
    ["paints a kept view the chat session lists", {}, "kept"],
    ["keeps painting it while the socket catches up", { status: "synchronizing" }, "kept"],
    ["hands over to live data in place", { status: "live" }, "live"],
    ["holds a kept view the session does not list", { threadId: other }, "hold"],
    [
      "holds a kept view until the live config names the session's threads",
      { liveConfig: null },
      "hold",
    ],
    [
      "holds a kept view when an older server names no thread set",
      { liveConfig: { chatSession: { ownerThreadIds: [] } } },
      "hold",
    ],
    [
      "paints a kept view for a full session without waiting",
      { chatSession: false, liveConfig: null },
      "kept",
    ],
    ["has nothing kept to hold with no data", { hasData: false, threadId: other }, "live"],
    [
      "lets a deleted thread show its deleted state",
      { status: "deleted", threadId: other },
      "live",
    ],
  ])("%s", (_name, change, expected) => {
    expect(embedKeptView({ ...base, ...change })).toBe(expected);
  });
});

const tailThread = ThreadId.make("thread-tail");

function tailRow(index: number, output: string): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`item-${index}`);
  return {
    position: index,
    visibility: "local",
    sourceThreadId: tailThread,
    sourceItemId: id,
    item: {
      id,
      type: "command_execution",
      threadId: tailThread,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed",
      title: `Command ${index}`,
      input: `cmd-${index}`,
      output,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    },
  } as OrchestrationV2ProjectedTurnItem;
}

function tailSnapshot(rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  const projection = {
    thread: { id: tailThread },
    runs: [],
    messages: [],
    runtimeRequests: [],
    turnItems: rows.map((row) => row.item),
    visibleTurnItems: rows,
  } as unknown as OrchestrationV2ThreadProjection;
  return { snapshotSequence: 42, projection };
}

const decodeCursor = (cursor: string | null | undefined) =>
  JSON.parse(atob((cursor ?? "").replaceAll("-", "+").replaceAll("_", "/"))) as unknown;

describe("keptTailSnapshot", () => {
  it("keeps the newest rows that fit the budget and a cursor to the rest", () => {
    const rows = Array.from({ length: 200 }, (_, index) => tailRow(index, "x".repeat(1000)));
    const tail = keptTailSnapshot(tailSnapshot(rows), 64 * 1024);
    const kept = tail?.projection.visibleTurnItems ?? [];
    expect(kept.length).toBeGreaterThan(1);
    expect(kept.length).toBeLessThan(rows.length);
    expect(kept.at(-1)).toBe(rows.at(-1));
    expect(kept).toEqual(rows.slice(rows.length - kept.length));
    expect(JSON.stringify(kept).length * 2).toBeLessThanOrEqual(64 * 1024);
    expect(tail?.projection.turnItems).toEqual(kept.map((row) => row.item));
    expect(tail?.hasMoreHistory).toBe(true);
    expect(tail?.snapshotSequence).toBe(0);
    expect(tail?.latestLocalTurnOrdinal).toBe(200);
    expect(decodeCursor(tail?.historyCursor)).toEqual({
      v: 1,
      seq: 42,
      st: tailThread,
      si: kept[0]?.sourceItemId,
      p: kept[0]?.position,
    });
  });

  it("keeps a whole thread that fits, with no cursor", () => {
    const rows = Array.from({ length: 3 }, (_, index) => tailRow(index, "x"));
    const tail = keptTailSnapshot(tailSnapshot(rows), 64 * 1024);
    expect(tail?.projection.visibleTurnItems).toEqual(rows);
    expect(tail?.snapshotSequence).toBe(42);
    expect(tail?.hasMoreHistory).toBe(false);
    expect(tail?.historyCursor).toBeNull();
  });

  it("keeps the newest row even when it alone is over the budget", () => {
    const rows = [tailRow(0, "x"), tailRow(1, "x".repeat(4096))];
    const tail = keptTailSnapshot(tailSnapshot(rows), 1024);
    expect(tail?.projection.visibleTurnItems).toEqual([rows[1]]);
  });
});

describe("embedConnectionRefused", () => {
  const refused = (reason: "authentication" | "permission" | "configuration") =>
    embedConnectionRefused({
      phase: "blocked",
      lastFailure: new ConnectionBlockedError({ reason, detail: "no" }),
    });
  it("treats a blocked sign-in or grant as unauthorized and nothing else", () => {
    expect(refused("authentication")).toBe(true);
    expect(refused("permission")).toBe(true);
    expect(refused("configuration")).toBe(false);
    expect(embedConnectionRefused({ phase: "backoff", lastFailure: null })).toBe(false);
  });
});
