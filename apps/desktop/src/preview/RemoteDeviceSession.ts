import { isLoopbackAddressHost } from "@t3tools/shared/hostClassification";
import type { Event, Session, WebContents } from "electron";
import { app } from "electron";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const LOCAL_SCHEMES = new Set(["data:", "blob:", "devtools:"]);
const BLANK_DOCUMENTS = new Set(["about:blank", "about:srcdoc"]);

const guardedSessions = new WeakSet<Session>();
let listening = false;

const canonicalAddress = (host: string) => {
  const bare = host
    .replace(/^\[|\]$/gu, "")
    .replace(/%.*$/u, "")
    .toLowerCase();
  const family = NodeNet.isIP(bare);
  if (family === 0) return undefined;
  const parsed = URL.parse(`http://${family === 6 ? `[${bare}]` : bare}/`)?.hostname.replace(
    /^\[|\]$/gu,
    "",
  );
  if (!parsed) return undefined;
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u.exec(parsed);
  if (!mapped) return parsed;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
};

const ownAddresses = () =>
  new Set(
    Object.values(NodeOS.networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .flatMap((entry) => {
        const address = canonicalAddress(entry.address);
        return address === undefined ? [] : [address];
      }),
  );

const isBlockedAddress = (address: string) =>
  isLoopbackAddressHost(address) ||
  address.startsWith("169.254.") ||
  /^fe[89ab][\da-f]:/u.test(address) ||
  ownAddresses().has(address);

export const isBlockedHost = (hostname: string) => {
  if (isLoopbackAddressHost(hostname)) return true;
  const address = canonicalAddress(hostname);
  return address !== undefined && isBlockedAddress(address);
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

const allowsRequest = async (session: Session, raw: string) => {
  const url = URL.parse(raw);
  if (url === null) return false;
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  if (!NETWORK_SCHEMES.has(url.protocol) || isBlockedHost(url.hostname)) return false;
  if (canonicalAddress(url.hostname) !== undefined) return true;
  const resolved = await session.resolveHost(url.hostname);
  return (
    resolved.endpoints.length > 0 &&
    resolved.endpoints.every((endpoint) => {
      const address = canonicalAddress(endpoint.address);
      return address !== undefined && !isBlockedAddress(address);
    })
  );
};

const guardContents = (contents: WebContents) => {
  const refuse = (event: Event<{ readonly url: string }>) => {
    if (!isNavigableUrl(event.url)) event.preventDefault();
  };
  contents.on("will-navigate", refuse);
  contents.on("will-frame-navigate", refuse);
  contents.on("will-redirect", refuse);
};

export const guard = (session: Session) => {
  if (guardedSessions.has(session)) return;
  guardedSessions.add(session);
  session.webRequest.onBeforeRequest((details, callback) => {
    allowsRequest(session, details.url).then(
      (allowed) => callback({ cancel: !allowed }),
      () => callback({ cancel: true }),
    );
  });
  if (listening) return;
  listening = true;
  app.on("web-contents-created", (_event, contents) => {
    if (guardedSessions.has(contents.session)) guardContents(contents);
  });
};
