export interface AutomationPlacement {
  readonly id?: string | undefined;
  readonly environmentId: string;
  readonly automationTaskId?: string | null | undefined;
  readonly automationPlacementAt?: string | null | undefined;
  readonly latestUserAuthoredMessageAt?: string | null | undefined;
  readonly pinnedAt?: string | null | undefined;
}

export function isAutomationOnlyThread(
  thread: AutomationPlacement,
  boundThreadKeys?: ReadonlySet<string>,
): boolean {
  if (thread.pinnedAt != null) return false;
  const bound = boundThreadKeys?.has(`${thread.environmentId}:${thread.id}`) === true;
  if (
    !bound &&
    thread.automationTaskId != null &&
    thread.automationTaskId !== `automation:thread:${thread.id}` &&
    boundThreadKeys?.has(thread.environmentId) === true &&
    !boundThreadKeys.has(`${thread.environmentId}:${thread.automationTaskId}`)
  )
    return false;
  if (thread.automationTaskId === null && !bound) return false;
  if (thread.automationTaskId === undefined && !bound) return false;
  if (thread.latestUserAuthoredMessageAt == null) return true;
  return (
    thread.automationPlacementAt != null &&
    Date.parse(thread.latestUserAuthoredMessageAt) <= Date.parse(thread.automationPlacementAt)
  );
}
