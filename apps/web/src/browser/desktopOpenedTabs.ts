import type { PreviewNavStatus, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

const STORAGE_KEY = "t3code:desktop-opened-preview-tabs";
const TAB_LIMIT = 500;
const URL_LIMIT = 20;

let opened: Map<string, ReadonlyArray<string>> | undefined;

const keyOf = (threadRef: ScopedThreadRef, tabId: string) =>
  JSON.stringify([threadRef.environmentId, threadRef.threadId, tabId]);

const canonical = (url: string) => URL.parse(url)?.href ?? url;

const stored = (): Map<string, ReadonlyArray<string>> => {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return new Map();
    return new Map(
      value.flatMap((entry): Array<[string, ReadonlyArray<string>]> =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        Array.isArray(entry[1]) &&
        entry[1].every((url: unknown) => typeof url === "string")
          ? [[entry[0], entry[1]]]
          : [],
      ),
    );
  } catch {
    return new Map();
  }
};

const openedTabs = () => (opened ??= stored());

const remember = (key: string, urls: ReadonlyArray<string>) => {
  const tabs = openedTabs();
  const previous = tabs.get(key) ?? [];
  const merged = [...previous.filter((url) => !urls.includes(url)), ...urls].slice(-URL_LIMIT);
  if (merged.length === previous.length && merged.every((url, index) => url === previous[index]))
    return;
  tabs.delete(key);
  tabs.set(key, merged);
  opened = new Map([...tabs].slice(-TAB_LIMIT));
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...opened]));
  } catch {}
};

const urlOf = (status: PreviewNavStatus) => (status._tag === "Idle" ? null : status.url);

export function recordDesktopOpenedTab(
  threadRef: ScopedThreadRef,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "tabId" | "navStatus">,
  requestedUrl?: string,
): void {
  if (snapshot.runtime === "server") return;
  const urls = [requestedUrl, urlOf(snapshot.navStatus)].filter(
    (url): url is string => url !== undefined && url !== null,
  );
  remember(keyOf(threadRef, snapshot.tabId), urls.map(canonical));
}

export function recordDesktopNavigation(
  threadRef: ScopedThreadRef,
  tabId: string,
  status: PreviewNavStatus,
): void {
  const key = keyOf(threadRef, tabId);
  const url = urlOf(status);
  if (url !== null && openedTabs().has(key)) remember(key, [canonical(url)]);
}

export function isDesktopOpenedTab(
  threadRef: ScopedThreadRef,
  snapshot: Pick<PreviewSessionSnapshot, "tabId" | "navStatus">,
): boolean {
  const urls = openedTabs().get(keyOf(threadRef, snapshot.tabId));
  if (urls === undefined) return false;
  const url = urlOf(snapshot.navStatus);
  return url === null || urls.includes(canonical(url));
}
