import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { embedKeptView, type EmbedKeptViewInput } from "./embedKeptViewGate";

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
