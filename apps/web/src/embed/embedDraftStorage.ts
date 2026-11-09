import { createMemoryStorage, type StateStorage } from "../lib/storage";

const EMBED_THREAD = /^\/embed\/[^/]+\/([^/]+)/;

function embedThread(): string | null {
  if (typeof window === "undefined") return null;
  const hit = EMBED_THREAD.exec(window.location.pathname);
  return hit ? decodeURIComponent(hit[1]!) : null;
}

export function draftKey(key: string): string {
  const thread = embedThread();
  return thread === null ? key : `${key}:embed:${thread}`;
}

export function draftStorage(): StateStorage {
  if (typeof localStorage === "undefined") return createMemoryStorage();
  if (embedThread() === null) return localStorage;
  return {
    getItem: (name) => localStorage.getItem(draftKey(name)) ?? localStorage.getItem(name),
    setItem: (name, value) => localStorage.setItem(draftKey(name), value),
    removeItem: (name) => localStorage.removeItem(draftKey(name)),
  };
}
