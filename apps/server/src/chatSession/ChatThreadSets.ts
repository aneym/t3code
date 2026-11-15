import {
  ChatSessionThreadIds,
  chatSessionSetId,
  isChatSessionScopes,
  type AuthEnvironmentScope,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceSqlError } from "../persistence/Errors.ts";

export interface ChatSession {
  readonly setId: string;
  readonly threads: ReadonlySet<ThreadId>;
}

const SET_RETENTION = Duration.days(2);
const ThreadIdsJson = Schema.fromJsonString(ChatSessionThreadIds);
const decodeThreadIds = Schema.decodeUnknownOption(ThreadIdsJson);
const encodeThreadIds = Schema.encodeEffect(ThreadIdsJson);

export class ChatThreadSets extends Context.Service<
  ChatThreadSets,
  {
    readonly create: (
      threadIds: ChatSessionThreadIds,
    ) => Effect.Effect<string, PersistenceSqlError>;
    readonly forSession: (session: {
      readonly subject: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<ChatSession | undefined, PersistenceSqlError>;
  }
>()("t3/chatSession/ChatThreadSets") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const sqlError = (operation: string) => (cause: unknown) =>
    new PersistenceSqlError({ operation, cause });

  const create = Effect.fn("ChatThreadSets.create")(function* (threadIds: ChatSessionThreadIds) {
    const setId = yield* random.uuidV4().pipe(Effect.mapError(sqlError("ChatThreadSets.id")));
    const threadIdsJson = yield* encodeThreadIds([...new Set(threadIds)]).pipe(
      Effect.mapError(sqlError("ChatThreadSets.encode")),
    );
    const now = yield* DateTime.now;
    const cutoff = DateTime.subtract(now, { milliseconds: Duration.toMillis(SET_RETENTION) });
    yield* sql`DELETE FROM auth_chat_thread_sets WHERE created_at < ${DateTime.formatIso(cutoff)}`.pipe(
      Effect.mapError(sqlError("ChatThreadSets.prune")),
    );
    yield* sql`
      INSERT INTO auth_chat_thread_sets (set_id, thread_ids_json, created_at)
      VALUES (${setId}, ${threadIdsJson}, ${DateTime.formatIso(now)})
    `.pipe(Effect.mapError(sqlError("ChatThreadSets.create")));
    return setId;
  });

  const forSession = Effect.fn("ChatThreadSets.forSession")(function* (session: {
    readonly subject: string;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  }) {
    if (!isChatSessionScopes(session.scopes)) return undefined;
    const setId = chatSessionSetId(session.subject) ?? "";
    const rows = yield* sql<{ readonly threadIdsJson: string }>`
      SELECT thread_ids_json AS "threadIdsJson" FROM auth_chat_thread_sets WHERE set_id = ${setId}
    `.pipe(Effect.mapError(sqlError("ChatThreadSets.forSession")));
    const threadIds = Option.flatMap(Option.fromNullishOr(rows[0]), (row) =>
      decodeThreadIds(row.threadIdsJson),
    );
    return {
      setId,
      threads: new Set(Option.getOrElse(threadIds, () => [])),
    } satisfies ChatSession;
  });

  return ChatThreadSets.of({ create, forSession });
});

export const layer = Layer.effect(ChatThreadSets, make);
