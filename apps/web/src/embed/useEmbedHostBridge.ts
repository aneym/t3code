import { useEffect } from "react";

import { isMacPlatform } from "../lib/utils";
import {
  channelForSpot,
  connectEmbedHost,
  openThroughEmbedHost,
  postToEmbedHost,
  type EmbedHostChannel,
} from "./embedHost";
import {
  applyEmbedClear,
  embedKClears,
  requestEmbedClear,
  setEmbedKClears,
  startEmbedClearView,
} from "./embedClearView";
import {
  EMBED_COMPOSER_FOCUS_MESSAGE,
  EMBED_KEY_MESSAGE,
  EMBED_READY_MESSAGE,
  readEmbedClearMessage,
  readEmbedKeysMessage,
  readEmbedThemeMessage,
  reservedEmbedChord,
} from "./embedProtocol";
import { applyEmbedTheme, themeFromEmbedMessage } from "./embedTheme";

const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const COMPOSER_EDITOR = '[data-testid="composer-editor"]';

function inComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_EDITOR) !== null;
}

function leavingLink(event: MouseEvent): URL | null {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return null;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return null;
  if (!URL.canParse(anchor.href)) return null;
  const url = new URL(anchor.href);
  if (!OPENABLE_PROTOCOLS.has(url.protocol)) return null;
  const leaves = url.origin !== window.location.origin || anchor.target === "_blank";
  return leaves ? url : null;
}

function fromHost(channel: EmbedHostChannel, event: MessageEvent): boolean {
  return channel.framed
    ? event.source === channel.target && event.origin === channel.origin
    : event.source === window && event.origin === window.location.origin;
}

export function useEmbedHostBridge(origin: string, framed: boolean, threadId: string): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- connects the host channel and window listeners for the embed's lifetime
  useEffect(() => {
    const stopClearView = startEmbedClearView(threadId);
    const channel = channelForSpot({ origin, framed });
    const disconnect = connectEmbedHost(channel);
    const mac = isMacPlatform(navigator.platform);
    const onMessage = (event: MessageEvent) => {
      if (!fromHost(channel, event)) return;
      const theme = readEmbedThemeMessage(event.data);
      if (theme !== null) applyEmbedTheme(themeFromEmbedMessage(theme));
      const clear = readEmbedClearMessage(event.data);
      if (clear !== null) applyEmbedClear(clear);
      const keys = readEmbedKeysMessage(event.data);
      if (keys !== null) setEmbedKClears(keys.kClears);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const key = reservedEmbedChord(event, mac);
      if (key === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      const clears =
        key === "mod+shift+k" || (key === "mod+k" && embedKClears() && inComposer(event.target));
      if (clears) requestEmbedClear(threadId);
      else postToEmbedHost({ type: EMBED_KEY_MESSAGE, key });
    };
    let composerFocused = false;
    const onFocusChange = (event: FocusEvent) => {
      const focused = inComposer(event.type === "focusin" ? event.target : event.relatedTarget);
      if (focused !== composerFocused) {
        composerFocused = focused;
        postToEmbedHost({ type: EMBED_COMPOSER_FOCUS_MESSAGE, focused });
      }
    };
    const onClick = (event: MouseEvent) => {
      const url = leavingLink(event);
      if (url === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openThroughEmbedHost(url.href);
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("auxclick", onClick, true);
    window.addEventListener("focusin", onFocusChange);
    window.addEventListener("focusout", onFocusChange);
    postToEmbedHost({ type: EMBED_READY_MESSAGE, threadId });
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("auxclick", onClick, true);
      window.removeEventListener("focusin", onFocusChange);
      window.removeEventListener("focusout", onFocusChange);
      stopClearView();
      disconnect();
    };
  }, [origin, framed, threadId]);
}
