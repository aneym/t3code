export function threadQueueSummary(childWaiting: boolean, queuedRunCount: number) {
  return (
    [
      childWaiting ? "Subagent waiting" : null,
      queuedRunCount === 0 ? null : `${queuedRunCount} queued`,
    ]
      .filter((part) => part !== null)
      .join(" · ") || null
  );
}
