import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  createInboxReturnTracker,
  isThreadWorking,
} from "@t3tools/client-runtime/state/thread-inbox";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";
import { createUnreachableEnvironmentTracker } from "@t3tools/client-runtime/state/unreachable-environments";

import {
  applySidebarThreadDrop,
  belongsInSidebarWorkingShelf,
  filterSidebarV2VisibleThreads,
  firstValidTimestampMs,
  orderItemsByPreferredIds,
  resolveSidebarReorderableThreadKeys,
  resolveSidebarThreadSection,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  type SidebarSection,
} from "../Sidebar.logic";

export const inboxReturns = createInboxReturnTracker();
export const unreachableEnvironments = createUnreachableEnvironmentTracker();

export type SidebarOptimisticDrop = {
  readonly key: string;
  readonly sourceSection: SidebarSection;
  readonly section: "pinned" | "active" | "settled";
  readonly occurredAt: string;
  readonly clearsSnooze: boolean;
  readonly order: readonly string[] | null;
  readonly keysAtDrop: ReadonlyMap<string, string | null>;
  readonly assignedKeys: ReadonlyMap<string, string>;
};

export interface SidebarThreadPartitionInput {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  /** Tasks linked environments run for a listed thread; they show under it. */
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly connectedEnvironmentIds: readonly EnvironmentId[];
  readonly optimisticDrop: SidebarOptimisticDrop | null;
  readonly workingShelfEnabled: boolean;
  readonly automationThreadKeys: ReadonlySet<string>;
  /** Boring mode: folders list active threads by the user's latest message. */
  readonly sortActiveBySend: boolean;
  readonly disconnectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly unreachableEnvironmentIds: ReadonlySet<EnvironmentId>;
  // Snooze wakes, the queued-turn grace and the Working shelf's exit grace depend
  // on the clock, so the minute tick, the precise snooze-wake tick and the inbox
  // tracker's expiry version are inputs: a new key repartitions.
  readonly clockKey: string;
}

export function partitionSidebarThreads(input: SidebarThreadPartitionInput) {
  const {
    threads,
    scopedProjectKeys,
    delegatedUnderParent,
    serverConfigs,
    optimisticDrop,
    workingShelfEnabled,
    sortActiveBySend,
    disconnectedEnvironmentIds,
    unreachableEnvironmentIds,
  } = input;
  const preciseNow = new Date().toISOString();
  const visible = filterSidebarV2VisibleThreads(
    threads,
    scopedProjectKeys,
    delegatedUnderParent,
    input.automationThreadKeys,
  );
  const inboxObservation = inboxReturns.observe(workingShelfEnabled ? threads : null);
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const inbox = (thread: EnvironmentThreadShell, manuallyMoved = false) =>
    belongsInSidebarWorkingShelf(thread, {
      enabled: workingShelfEnabled,
      disconnectedEnvironmentIds,
      isWorking: manuallyMoved ? isThreadWorking : inboxObservation.isWorking,
    })
      ? working
      : active;
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const offline: EnvironmentThreadShell[] = [];
  const { draggableThreadKeys, activeReorderableThreadKeys } = resolveSidebarReorderableThreadKeys({
    threads: visible,
    serverConfigs,
    connectedEnvironmentIds: input.connectedEnvironmentIds,
  });
  for (const thread of visible) {
    const configLoaded = serverConfigs.has(thread.environmentId);
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (unreachableEnvironmentIds.has(thread.environmentId)) {
      offline.push(thread);
    } else if (optimisticDrop?.key === threadKey) {
      const projected = applySidebarThreadDrop(
        thread,
        optimisticDrop.section,
        optimisticDrop.occurredAt,
        optimisticDrop.assignedKeys.get(threadKey),
      );
      (optimisticDrop.section === "pinned"
        ? pinned
        : optimisticDrop.section === "settled"
          ? settled
          : inbox(projected, true)
      ).push(
        optimisticDrop.clearsSnooze
          ? projected
          : { ...projected, snoozedAt: thread.snoozedAt, snoozedUntil: thread.snoozedUntil },
      );
    } else {
      const section = resolveSidebarThreadSection({
        snoozed: configLoaded && effectiveSnoozed(thread, { now: preciseNow }),
        settled: configLoaded && thread.settledOverride === "settled",
        pinned: thread.pinnedAt != null,
      });
      (section === "snoozed"
        ? snoozed
        : section === "settled"
          ? settled
          : section === "pinned"
            ? pinned
            : inbox(thread)
      ).push(thread);
    }
  }
  // Availability gates dragging only; sorting must stay consistent across clients.
  const sortedPinned = sortPinnedThreadsForSidebar(pinned);
  const sortedActive = sortActiveBySend
    ? sortWorkingThreadsBySend(active)
    : workingShelfEnabled
      ? sortInboxThreadsByReturn(active, inboxObservation.returnedAt)
      : sortThreadsForSidebar(active);
  return {
    pinnedThreads:
      optimisticDrop?.section !== "pinned" || optimisticDrop.order === null
        ? sortedPinned
        : orderItemsByPreferredIds({
            items: sortedPinned,
            preferredIds: optimisticDrop.order,
            getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          }),
    draggableThreadKeys,
    activeReorderableThreadKeys,
    activeThreads:
      optimisticDrop?.section !== "active" || optimisticDrop.order === null
        ? sortedActive
        : orderItemsByPreferredIds({
            items: sortedActive,
            preferredIds: optimisticDrop.order,
            getId: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          }),
    workingThreads: sortWorkingThreadsBySend(working),
    snoozedThreads: snoozed.toSorted(
      (left, right) =>
        firstValidTimestampMs(left.snoozedUntil ?? null) -
        firstValidTimestampMs(right.snoozedUntil ?? null),
    ),
    settledThreads: sortSettledThreads(settled),
    offlineThreads: sortThreadsForSidebar(offline),
    visibleThreads: visible,
    snoozeNow: preciseNow,
  };
}
