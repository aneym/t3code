import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ASSET_ROUTE_PREFIX } from "../assets/AssetAccess.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "../assets/AttachmentUpload.ts";

const MAX_GRANTS_PER_SET = 5_000;

interface SetGrants {
  readonly urls: Map<string, number>;
  readonly uploads: Map<string, number>;
}

export class ChatSessionGrants extends Context.Service<
  ChatSessionGrants,
  {
    readonly recordUrl: (
      setId: string,
      relativeUrl: string,
      expiresAt: number,
    ) => Effect.Effect<void>;
    readonly recordUpload: (
      setId: string,
      attachmentId: string,
      relativeUrl: string,
      expiresAt: number,
    ) => Effect.Effect<void>;
    readonly allowsPath: (setId: string, pathname: string) => Effect.Effect<boolean>;
    readonly ownsUpload: (setId: string, attachmentId: string) => Effect.Effect<boolean>;
  }
>()("t3/chatSession/ChatSessionGrants") {}

const grantKey = (pathname: string): string | null => {
  if (pathname.startsWith(`${ASSET_ROUTE_PREFIX}/`)) {
    const token = pathname.slice(ASSET_ROUTE_PREFIX.length + 1).split("/", 1)[0];
    return token ? `${ASSET_ROUTE_PREFIX}/${token}` : null;
  }
  if (pathname.startsWith(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`)) return pathname;
  return null;
};

const prune = (entries: Map<string, number>, now: number) => {
  for (const [key, expiresAt] of entries) if (expiresAt <= now) entries.delete(key);
  while (entries.size > MAX_GRANTS_PER_SET) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
};

const make = Effect.sync(() => {
  const sets = new Map<string, SetGrants>();
  const grantsFor = (setId: string) => {
    let grants = sets.get(setId);
    if (grants === undefined) {
      grants = { urls: new Map(), uploads: new Map() };
      sets.set(setId, grants);
    }
    return grants;
  };
  const record = (setId: string, relativeUrl: string, expiresAt: number, now: number) => {
    const key = grantKey(new URL(relativeUrl, "http://chat.invalid").pathname);
    if (key === null) return;
    const grants = grantsFor(setId);
    grants.urls.set(key, expiresAt);
    prune(grants.urls, now);
  };
  return ChatSessionGrants.of({
    recordUrl: Effect.fn("ChatSessionGrants.recordUrl")(function* (setId, relativeUrl, expiresAt) {
      record(setId, relativeUrl, expiresAt, yield* Clock.currentTimeMillis);
    }),
    recordUpload: Effect.fn("ChatSessionGrants.recordUpload")(
      function* (setId, attachmentId, relativeUrl, expiresAt) {
        const now = yield* Clock.currentTimeMillis;
        record(setId, relativeUrl, expiresAt, now);
        const grants = grantsFor(setId);
        grants.uploads.set(attachmentId, Number.MAX_SAFE_INTEGER);
        prune(grants.uploads, now);
      },
    ),
    allowsPath: Effect.fn("ChatSessionGrants.allowsPath")(function* (setId, pathname) {
      const key = grantKey(pathname);
      const expiresAt = key === null ? undefined : sets.get(setId)?.urls.get(key);
      return expiresAt !== undefined && expiresAt > (yield* Clock.currentTimeMillis);
    }),
    ownsUpload: Effect.fn("ChatSessionGrants.ownsUpload")((setId, attachmentId) =>
      Effect.sync(() => sets.get(setId)?.uploads.has(attachmentId) === true),
    ),
  });
});

export const layer = Layer.effect(ChatSessionGrants, make);
