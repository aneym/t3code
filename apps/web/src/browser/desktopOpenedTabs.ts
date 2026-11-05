import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

const STORAGE_KEY = "t3code:desktop-opened-preview-tabs";
const LIMIT = 500;

let opened: Set<string> | undefined;

const keyOf = (threadRef: ScopedThreadRef, tabId: string) =>
  JSON.stringify([threadRef.environmentId, threadRef.threadId, tabId]);

const stored = (): ReadonlyArray<string> => {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
};

const openedTabs = () => (opened ??= new Set(stored()));

export function recordDesktopOpenedTab(
  threadRef: ScopedThreadRef,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "tabId">,
): void {
  if (snapshot.runtime === "server") return;
  const key = keyOf(threadRef, snapshot.tabId);
  const tabs = openedTabs();
  if (tabs.has(key)) return;
  const kept = [...tabs, key].slice(-LIMIT);
  opened = new Set(kept);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {}
}

export function isDesktopOpenedTab(threadRef: ScopedThreadRef, tabId: string): boolean {
  return openedTabs().has(keyOf(threadRef, tabId));
}
