import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ASSET_ROUTE_PREFIX } from "../assets/AssetAccess.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "../assets/AttachmentUpload.ts";

const MAX_GRANTS_PER_SET = 5_000;

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
    readonly isBound: (pathname: string) => Effect.Effect<boolean>;
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const urls = new Map<string, Map<string, number>>();
  const uploads = new Map<string, Set<string>>();
  const startedAt = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM auth_chat_session_set_url_grants WHERE expires_at <= ${startedAt}`.pipe(
    Effect.orDie,
  );
  const rows = yield* sql<{
    readonly key: string;
    readonly setId: string;
    readonly expiresAt: number;
  }>`
    SELECT grant_key AS "key", set_id AS "setId", expires_at AS "expiresAt"
    FROM auth_chat_session_set_url_grants
  `.pipe(Effect.orDie);
  const put = (key: string, setId: string, expiresAt: number) => {
    let sets = urls.get(key);
    if (sets === undefined) {
      sets = new Map();
      urls.set(key, sets);
    }
    sets.set(setId, expiresAt);
  };
  for (const row of rows) put(row.key, row.setId, row.expiresAt);

  const liveSets = (key: string | null, now: number) =>
    [...((key === null ? undefined : urls.get(key)) ?? new Map<string, number>())]
      .filter(([, expiresAt]) => expiresAt > now)
      .map(([setId]) => setId);

  const record = Effect.fnUntraced(function* (
    setId: string,
    relativeUrl: string,
    expiresAt: number,
  ) {
    const key = grantKey(new URL(relativeUrl, "http://chat.invalid").pathname);
    if (key === null) return yield* Effect.die(new Error("A chat session URL has no grant key."));
    const now = yield* Clock.currentTimeMillis;
    let setGrants = 0;
    for (const [entryKey, sets] of urls) {
      for (const [entrySet, entryExpiresAt] of sets) {
        if (entryExpiresAt <= now) sets.delete(entrySet);
        else if (entrySet === setId) setGrants += 1;
      }
      if (sets.size === 0) urls.delete(entryKey);
    }
    if (setGrants >= MAX_GRANTS_PER_SET) {
      return yield* Effect.die(new Error("A chat session holds too many live URLs."));
    }
    put(key, setId, expiresAt);
    yield* sql`
      INSERT OR REPLACE INTO auth_chat_session_set_url_grants (grant_key, set_id, expires_at)
      VALUES (${key}, ${setId}, ${expiresAt})
    `.pipe(Effect.orDie);
    yield* sql`DELETE FROM auth_chat_session_set_url_grants WHERE expires_at <= ${now}`.pipe(
      Effect.orDie,
    );
  });

  return ChatSessionGrants.of({
    recordUrl: Effect.fn("ChatSessionGrants.recordUrl")(function* (setId, relativeUrl, expiresAt) {
      yield* record(setId, relativeUrl, expiresAt);
    }),
    recordUpload: Effect.fn("ChatSessionGrants.recordUpload")(
      function* (setId, attachmentId, relativeUrl, expiresAt) {
        yield* record(setId, relativeUrl, expiresAt);
        let owned = uploads.get(setId);
        if (owned === undefined) {
          owned = new Set();
          uploads.set(setId, owned);
        }
        owned.add(attachmentId);
        while (owned.size > MAX_GRANTS_PER_SET) {
          const oldest = owned.values().next();
          if (oldest.done) break;
          owned.delete(oldest.value);
        }
      },
    ),
    allowsPath: Effect.fn("ChatSessionGrants.allowsPath")(function* (setId, pathname) {
      return liveSets(grantKey(pathname), yield* Clock.currentTimeMillis).includes(setId);
    }),
    isBound: Effect.fn("ChatSessionGrants.isBound")(function* (pathname) {
      return liveSets(grantKey(pathname), yield* Clock.currentTimeMillis).length > 0;
    }),
    ownsUpload: Effect.fn("ChatSessionGrants.ownsUpload")((setId, attachmentId) =>
      Effect.sync(() => uploads.get(setId)?.has(attachmentId) === true),
    ),
  });
});

export const layer = Layer.effect(ChatSessionGrants, make);
