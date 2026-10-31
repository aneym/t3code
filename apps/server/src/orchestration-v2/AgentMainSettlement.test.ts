import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { isAutoSettlementCandidate } from "./AutoSettlementPolicy.ts";
import type { ProjectionSettlementCandidate } from "./ProjectionStore.ts";

it("protects agent main threads until unbound", () => {
  const thread = {
    id: ThreadId.make("bound-home"),
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    activityRunStatus: null,
    snoozedUntil: null,
    latestUserMessageAt: null,
  } as ProjectionSettlementCandidate;
  const bindings = new Set([thread.id]);
  expect(isAutoSettlementCandidate(thread, 0, bindings)).toBe(false);
  bindings.clear();
  expect(isAutoSettlementCandidate(thread, 0, bindings)).toBe(true);
});
