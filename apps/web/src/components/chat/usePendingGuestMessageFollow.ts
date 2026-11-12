import { useEffect, useRef } from "react";

export function usePendingGuestMessageFollow(input: {
  readonly guestMessages:
    | ReadonlyArray<{ readonly id: string; readonly status: string }>
    | undefined;
  readonly routeThreadKey: string;
  readonly liveFollowEnabled: boolean;
  readonly scrollToEnd: (immediate: boolean) => void;
}): number {
  const { routeThreadKey, liveFollowEnabled, scrollToEnd } = input;
  const pendingIds =
    input.guestMessages?.flatMap((message) => (message.status === "pending" ? [message.id] : [])) ??
    [];
  const pendingKey = pendingIds.join(",");
  const previousRef = useRef({ threadKey: routeThreadKey, key: pendingKey });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the timeline list to the end when a new pending guest message joins its footer
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { threadKey: routeThreadKey, key: pendingKey };
    // Opening another thread is not a new message; its own scroll position wins.
    if (previous.threadKey !== routeThreadKey) return;
    // Pending guest messages sit in the list footer, which the list does not follow on its own.
    // The follow flag reflects the owner's position before the footer grew; a live measure may not.
    // Any new id counts, even when another one was resolved in the same update.
    const previousIds = new Set(previous.key.split(","));
    const hasNewMessage = pendingKey.split(",").some((id) => id !== "" && !previousIds.has(id));
    if (hasNewMessage && liveFollowEnabled) scrollToEnd(true);
  }, [routeThreadKey, pendingKey, liveFollowEnabled, scrollToEnd]);
  return pendingIds.length;
}
