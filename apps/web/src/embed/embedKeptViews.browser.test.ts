import { describe, expect, it } from "vite-plus/test";

import {
  KEPT_VIEW_LIMITS,
  clearKeptViewsFor,
  forgetKeptViews,
  loadKeptView,
  markKeptViewShown,
  reopenKeptViews,
  retainKeptViewsOf,
  saveKeptView,
  wipeKeptViews,
} from "./embedKeptViews";

const keptThreads = async (environmentId: string, count: number) => {
  const kept: Array<number> = [];
  for (let index = 0; index < count; index += 1) {
    if ((await loadKeptView(environmentId, `thread-${index}`)) !== undefined) kept.push(index);
  }
  return kept;
};

describe("kept views in IndexedDB", () => {
  it("keys each view by environment and thread", async () => {
    await forgetKeptViews();
    await saveKeptView("env-a", "thread-1", "a1", 1);
    await saveKeptView("env-b", "thread-1", "b1", 2);
    expect(await loadKeptView("env-a", "thread-1")).toBe("a1");
    expect(await loadKeptView("env-b", "thread-1")).toBe("b1");
    expect(await loadKeptView("env-a", "thread-2")).toBeUndefined();
  });

  it("evicts the least recently shown view past the entry cap", async () => {
    await forgetKeptViews();
    const { maxEntries } = KEPT_VIEW_LIMITS;
    for (let index = 0; index < maxEntries; index += 1) {
      await saveKeptView("env-a", `thread-${index}`, "x", 10 + index);
    }
    await markKeptViewShown("env-a", "thread-0", 10_000);
    await saveKeptView("env-a", `thread-${maxEntries}`, "x", 20_000);
    const kept = await keptThreads("env-a", maxEntries + 1);
    expect(kept).toHaveLength(maxEntries);
    expect(kept).not.toContain(1);
    expect(kept).toContain(0);
    expect(kept).toContain(maxEntries);
  });

  it("evicts the least recently shown views past the size cap", async () => {
    await forgetKeptViews();
    const view = "x".repeat(KEPT_VIEW_LIMITS.maxEntryLength);
    const fits = KEPT_VIEW_LIMITS.maxLength / KEPT_VIEW_LIMITS.maxEntryLength;
    for (let index = 0; index <= fits; index += 1) {
      await saveKeptView("env-a", `thread-${index}`, view, 10 + index);
    }
    const kept = await keptThreads("env-a", fits + 1);
    expect(kept).toHaveLength(fits);
    expect(kept).not.toContain(0);
  });

  it("clears on sign-out, on an environment's removal and on an environment change", async () => {
    await forgetKeptViews();
    await saveKeptView("env-a", "thread-0", "a", 1);
    await saveKeptView("env-b", "thread-0", "b", 2);
    await saveKeptView("env-c", "thread-0", "c", 3);
    await clearKeptViewsFor("env-c");
    expect(await keptThreads("env-c", 1)).toEqual([]);
    expect(await keptThreads("env-a", 1)).toEqual([0]);
    await retainKeptViewsOf(new Set(["env-b"]));
    expect(await keptThreads("env-a", 1)).toEqual([]);
    expect(await keptThreads("env-b", 1)).toEqual([0]);
    await forgetKeptViews();
    expect(await keptThreads("env-b", 1)).toEqual([]);
  });

  it("wipes every view on an unauthorized close and keeps later saves out until reopened", async () => {
    await forgetKeptViews();
    await saveKeptView("env-a", "thread-0", "a", 1);
    await saveKeptView("env-b", "thread-0", "b", 2);
    const late = saveKeptView("env-a", "thread-1", "late", 3);
    await wipeKeptViews();
    await late;
    await saveKeptView("env-a", "thread-2", "after", 4);
    expect(await keptThreads("env-a", 3)).toEqual([]);
    expect(await keptThreads("env-b", 1)).toEqual([]);
    reopenKeptViews();
    await saveKeptView("env-a", "thread-2", "back", 5);
    expect(await keptThreads("env-a", 3)).toEqual([2]);
  });
});
