import { EMBED_WARM_LIMIT, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  embedThreadVisibility,
  planEmbedRoute,
  readEmbedRouteMessage,
  readEmbedWarmMessage,
} from "./embedRouting";
import { createEmbedWarmSet } from "./embedWarmSet";

const shell = (
  threads: ReadonlyArray<string>,
  extra: Partial<OrchestrationV2ShellSnapshot> = {},
): Option.Option<OrchestrationV2ShellSnapshot> =>
  Option.some({
    schemaVersion: 1,
    snapshotSequence: 1,
    threads: threads.map((id) => ({ id })),
    archivedThreads: [],
    projects: [],
    ...extra,
  } as unknown as OrchestrationV2ShellSnapshot);

describe("embed route messages", () => {
  it.each([
    [{ type: "t3-embed/route", thread: "thread-b" }, "thread-b"],
    [{ type: "t3-embed/route", thread: "" }, null],
    [{ type: "t3-embed/route", thread: "../providers" }, null],
    [{ type: "t3-embed/route" }, null],
    [{ type: "t3-embed/warm", thread: "thread-b" }, null],
  ])("reads %j", (data, thread) => {
    expect(Option.getOrNull(readEmbedRouteMessage(data))?.thread ?? null).toBe(thread);
  });

  it("refuses a warm list over the limit", () => {
    const threads = Array.from({ length: EMBED_WARM_LIMIT + 1 }, (_, index) => `t${index}`);
    expect(Option.isNone(readEmbedWarmMessage({ type: "t3-embed/warm", threads }))).toBe(true);
    expect(
      Option.isSome(
        readEmbedWarmMessage({
          type: "t3-embed/warm",
          threads: threads.slice(0, EMBED_WARM_LIMIT),
        }),
      ),
    ).toBe(true);
  });
});

describe("planEmbedRoute", () => {
  const visible = embedThreadVisibility(
    shell(["a"], { archivedThreads: [{ id: "old" }] } as never),
  );

  it.each([
    ["a", "a", visible, { kind: "same" }],
    ["old", "a", visible, { kind: "navigate" }],
    ["hidden", "a", visible, { kind: "refused", reason: "not-visible" }],
    ["a", null, null, { kind: "refused", reason: "not-synced" }],
  ] as const)("routes %s from %s", (thread, current, visibility, plan) => {
    expect(planEmbedRoute(thread, current, visibility)).toEqual(plan);
  });

  it("leaves threads cut from an older-settled shell to the server", () => {
    const cut = embedThreadVisibility(
      shell(["a"], { olderSettled: { before: "", asOfSequence: 1, counts: [] } } as never),
    );
    expect(planEmbedRoute("older", "a", cut)).toEqual({ kind: "navigate" });
  });
});

describe("createEmbedWarmSet", () => {
  const track = () => {
    const mounted = new Set<string>();
    const mounts: Array<string> = [];
    const set = createEmbedWarmSet(3, (thread) => {
      mounted.add(thread);
      mounts.push(thread);
      return () => mounted.delete(thread);
    });
    return { set, mounted, mounts };
  };

  it("evicts the least recently shown thread, never the shown one", () => {
    const { set, mounted, mounts } = track();
    set.show("a");
    set.warm(["b", "c"]);
    set.show("b");
    set.warm(["d", "e"]);
    expect([...mounted].toSorted()).toEqual(["b", "d", "e"]);
    set.warm(["f", "g", "h"]);
    expect([...mounted].toSorted()).toEqual(["b", "f", "g"]);
    expect(mounts).not.toContain("h");
    set.show("b");
    expect(mounts.filter((thread) => thread === "b")).toHaveLength(1);
  });

  it("releases every subscription on clear", () => {
    const { set, mounted } = track();
    set.show("a");
    set.warm(["b"]);
    set.clear();
    expect(mounted.size).toBe(0);
  });
});
