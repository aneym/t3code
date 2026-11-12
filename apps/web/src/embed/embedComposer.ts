import { useSyncExternalStore } from "react";

import { postToEmbedHost } from "./embedHost";
import {
  EMBED_CONTROLS_MESSAGE,
  readEmbedControls,
  type EmbedComposerMessage,
  type EmbedControls,
} from "./embedProtocol";

const STORAGE_KEY = "t3code:embed-composer-controls";

let controls: EmbedControls = "hidden";
let key: string | null = null;
const listeners = new Set<() => void>();

function stored(): EmbedControls | null {
  try {
    return readEmbedControls(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function keep(next: EmbedControls): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    return;
  }
}

function apply(next: EmbedControls): void {
  controls = next;
  document.documentElement.dataset.embedControls = next;
  for (const listener of listeners) listener();
}

export function startEmbedControls(): void {
  const fromUrl = readEmbedControls(new URLSearchParams(window.location.search).get("controls"));
  apply(fromUrl ?? stored() ?? "hidden");
}

export function applyEmbedComposerMessage(message: EmbedComposerMessage): void {
  key = message.key;
  if (message.controls !== null) keep(message.controls);
  apply(message.controls ?? controls);
}

export function toggleEmbedControls(): void {
  const next = controls === "shown" ? "hidden" : "shown";
  keep(next);
  apply(next);
  postToEmbedHost({ type: EMBED_CONTROLS_MESSAGE, shown: next === "shown" });
}

export function embedControlsKey(): string | null {
  return key;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEmbedControlsShown(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => controls === "shown",
    () => false,
  );
}

export function useEmbedControlsKey(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => key,
    () => null,
  );
}
