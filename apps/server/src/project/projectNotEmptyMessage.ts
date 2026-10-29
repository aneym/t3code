const LISTED_THREADS = 10;

export function projectNotEmptyMessage(blockingThreadIds: ReadonlyArray<string> = []): string {
  if (blockingThreadIds.length === 0) {
    return "Project not empty: use force=true to delete archived threads.";
  }
  const listed = blockingThreadIds.slice(0, LISTED_THREADS).join(", ");
  const hidden = blockingThreadIds.length - LISTED_THREADS;
  const more = hidden > 0 ? ` and ${hidden} more` : "";
  return `Project not empty: archive unarchived threads ${listed}${more}.`;
}
