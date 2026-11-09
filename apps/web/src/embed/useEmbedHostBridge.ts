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
  applyEmbedClearMessage,
  embedKClears,
  requestEmbedClear,
  setEmbedKClears,
  startEmbedClear,
} from "./embedClear";
import { applyEmbedComposerMessage, embedControlsKey, toggleEmbedControls } from "./embedComposer";
import {
  EMBED_COMPOSER_FOCUS_MESSAGE,
  EMBED_KEY_MESSAGE,
  EMBED_READY_MESSAGE,
  pressedHostChord,
  readEmbedClearMessage,
  readEmbedComposerMessage,
  readEmbedKeysMessage,
  readEmbedThemeMessage,
  reservedEmbedChord,
} from "./embedProtocol";
import { loadEmbedFonts, readEmbedFonts } from "./embedFonts";
import { applyEmbedLinksMessage, isEmbedRailsUrl } from "./embedLinks";
import { applyEmbedTheme, themeFromEmbedMessage } from "./embedTheme";

const COMPOSER_SELECTOR = '[data-testid="composer-editor"]';

function composerFocused(): boolean {
  const active = document.activeElement;
  return (
    document.hasFocus() && active instanceof Element && active.closest(COMPOSER_SELECTOR) !== null
  );
}

function clearsView(key: string): boolean {
  return key === "mod+shift+k" || (key === "mod+k" && embedKClears() && composerFocused());
}

const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

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
    const channel = channelForSpot({ origin, framed });
    const disconnect = connectEmbedHost(channel);
    const stopClear = startEmbedClear(threadId);
    let focused = false;
    const reportFocus = () => {
      const next = composerFocused();
      if (next === focused) return;
      focused = next;
      postToEmbedHost({ type: EMBED_COMPOSER_FOCUS_MESSAGE, focused });
    };
    const onFocusChange = () => queueMicrotask(reportFocus);
    const mac = isMacPlatform(navigator.platform);
    const onMessage = (event: MessageEvent) => {
      if (!fromHost(channel, event)) return;
      const theme = readEmbedThemeMessage(event.data);
      if (theme !== null) {
        applyEmbedTheme(themeFromEmbedMessage(theme));
        loadEmbedFonts(readEmbedFonts(event.data));
      }
      const clear = readEmbedClearMessage(event.data);
      if (clear !== null) applyEmbedClearMessage(clear);
      const keys = readEmbedKeysMessage(event.data);
      if (keys !== null) setEmbedKClears(keys.kClears);
      const composer = readEmbedComposerMessage(event.data);
      if (composer !== null) applyEmbedComposerMessage(composer);
      applyEmbedLinksMessage(event.data);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const controlsKey = embedControlsKey();
      if (controlsKey !== null && pressedHostChord(event, controlsKey, mac)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) toggleEmbedControls();
        return;
      }
      const key = reservedEmbedChord(event, mac);
      if (key === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (clearsView(key)) requestEmbedClear();
      else postToEmbedHost({ type: EMBED_KEY_MESSAGE, key });
    };
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (anchor?.querySelector("[data-rails-link-gone]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const url = leavingLink(event);
      if (url === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const tab = event.button === 1 || (mac ? event.metaKey : event.ctrlKey);
      openThroughEmbedHost(url.href, tab && isEmbedRailsUrl(url.href));
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("auxclick", onClick, true);
    window.addEventListener("focusin", onFocusChange);
    window.addEventListener("focusout", onFocusChange);
    window.addEventListener("focus", onFocusChange);
    window.addEventListener("blur", onFocusChange);
    postToEmbedHost({ type: EMBED_READY_MESSAGE, threadId });
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("auxclick", onClick, true);
      window.removeEventListener("focusin", onFocusChange);
      window.removeEventListener("focusout", onFocusChange);
      window.removeEventListener("focus", onFocusChange);
      window.removeEventListener("blur", onFocusChange);
      stopClear();
      disconnect();
    };
  }, [origin, framed, threadId]);
}
