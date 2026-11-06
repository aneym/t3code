import type { Event, Session, WebContents } from "electron";
import { app, webContents } from "electron";

import { isBlockedHost } from "./RemoteDeviceAddress.ts";
import * as RemoteDeviceProxy from "./RemoteDeviceProxy.ts";

const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const LOCAL_SCHEMES = new Set(["data:", "blob:", "devtools:"]);
const BLANK_DOCUMENTS = new Set(["about:blank", "about:srcdoc"]);
const FRAME_REQUESTS = new Set(["mainFrame", "subFrame"]);

const guardedSessions = new WeakSet<Session>();
const guardedTabs = new Map<string, number>();
const guarding = new WeakMap<Session, Promise<void>>();
let listening = false;

export const isWebUrl = (raw: string) => {
  if (BLANK_DOCUMENTS.has(raw)) return true;
  const protocol = URL.parse(raw)?.protocol;
  return protocol === "http:" || protocol === "https:";
};

export const isNavigableUrl = (raw: string) => {
  if (BLANK_DOCUMENTS.has(raw)) return true;
  const url = URL.parse(raw);
  return (
    url !== null &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    !isBlockedHost(url.hostname)
  );
};

const allowsRequest = (raw: string) => {
  const url = URL.parse(raw);
  if (url === null) return false;
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  return NETWORK_SCHEMES.has(url.protocol) && !isBlockedHost(url.hostname);
};

const guardContents = (contents: WebContents) => {
  const refuse = (event: Event<{ readonly url: string }>) => {
    if (!isNavigableUrl(event.url)) event.preventDefault();
  };
  contents.on("will-navigate", refuse);
  contents.on("will-frame-navigate", refuse);
  contents.on("will-redirect", refuse);
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
};

const install = async (session: Session) => {
  const proxyPort = await RemoteDeviceProxy.port();
  await session.setProxy({
    proxyRules: `127.0.0.1:${proxyPort}`,
    proxyBypassRules: "<-loopback>",
  });
  session.webRequest.onBeforeRequest((details, callback) => {
    if (!allowsRequest(details.url)) return callback({ cancel: true });
    if (!FRAME_REQUESTS.has(details.resourceType)) return callback({});
    const host = URL.parse(details.url)?.hostname ?? "";
    RemoteDeviceProxy.pinnedAddress(host).then(
      (address) => callback({ cancel: address === undefined }),
      () => callback({}),
    );
  });
  session.on("will-download", (event) => event.preventDefault());
  guardedSessions.add(session);
  if (listening) return;
  listening = true;
  app.on("web-contents-created", (_event, contents) => {
    if (guardedSessions.has(contents.session)) guardContents(contents);
  });
};

export const isGuarded = (session: Session) => guardedSessions.has(session);

export const registerTab = (tabId: string, webContentsId: number) => {
  const contents = webContents.fromId(webContentsId);
  if (contents && isGuarded(contents.session)) guardedTabs.set(tabId, webContentsId);
  else guardedTabs.delete(tabId);
};

export const guardedTab = (tabId: string) => {
  const id = guardedTabs.get(tabId);
  const contents = id === undefined ? undefined : webContents.fromId(id);
  if (!contents || contents.isDestroyed() || !isGuarded(contents.session)) return undefined;
  return contents;
};

export const guard = (session: Session) => {
  const pending = guarding.get(session) ?? install(session);
  guarding.set(session, pending);
  return pending;
};
