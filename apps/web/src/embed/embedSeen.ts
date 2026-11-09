import { useEffect } from "react";

const key = (threadId: string) => `t3code:embed-seen:${threadId}`;
const opened = new Map<string, string | null>();

function read(threadId: string): string | null {
  try {
    return localStorage.getItem(key(threadId));
  } catch {
    return null;
  }
}

function mark(threadId: string): void {
  try {
    localStorage.setItem(key(threadId), new Date().toISOString());
  } catch {}
}

export function embedSeenAt(threadId: string): string | null {
  if (!opened.has(threadId)) opened.set(threadId, read(threadId));
  return opened.get(threadId) ?? null;
}

export function useEmbedSeenMark(threadId: string | null): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds visibilitychange and pagehide listeners that write this thread's last-seen time to localStorage while it is open
  useEffect(() => {
    if (threadId === null) return;
    embedSeenAt(threadId);
    const leave = () => {
      if (document.visibilityState === "hidden") mark(threadId);
    };
    const gone = () => mark(threadId);
    document.addEventListener("visibilitychange", leave);
    addEventListener("pagehide", gone);
    return () => {
      document.removeEventListener("visibilitychange", leave);
      removeEventListener("pagehide", gone);
      mark(threadId);
    };
  }, [threadId]);
}
