import { useSyncExternalStore } from "react";

import { postToEmbedHost } from "./embedHost";
import { EMBED_HOST_VOICE_MESSAGE, EMBED_HOST_VOICE_PRESS_MESSAGE } from "./embedProtocol";

const MAX_LABEL_LENGTH = 120;

export type EmbedHostVoice = {
  readonly shown: boolean;
  readonly active: boolean;
  readonly label: string;
};

const HIDDEN: EmbedHostVoice = { shown: false, active: false, label: "" };

let hostVoice: EmbedHostVoice = HIDDEN;
const listeners = new Set<() => void>();

export function readEmbedHostVoiceMessage(data: unknown): EmbedHostVoice | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type !== EMBED_HOST_VOICE_MESSAGE || message.version !== 1) return null;
  const label = typeof message.label === "string" ? message.label.trim() : "";
  if (message.shown !== true || label.length === 0) return HIDDEN;
  return {
    shown: true,
    active: message.active === true,
    label: label.slice(0, MAX_LABEL_LENGTH),
  };
}

export function applyEmbedHostVoice(next: EmbedHostVoice): void {
  if (
    next.shown === hostVoice.shown &&
    next.active === hostVoice.active &&
    next.label === hostVoice.label
  )
    return;
  hostVoice = next;
  for (const listener of listeners) listener();
}

export function pressEmbedHostVoice(): void {
  if (hostVoice.shown) postToEmbedHost({ type: EMBED_HOST_VOICE_PRESS_MESSAGE });
}

export function useEmbedHostVoice(): EmbedHostVoice {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => hostVoice,
    () => HIDDEN,
  );
}
