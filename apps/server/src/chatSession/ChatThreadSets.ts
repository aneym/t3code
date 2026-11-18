import {
  ChatSessionOwnerThreadIds,
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
  readonly ownerThreads: ReadonlySet<ThreadId>;
}

const SET_RETENTION = Duration.days(2);
const ThreadIdsJson = Schema.fromJsonString(ChatSessionThreadIds);
const decodeThreadIds = Schema.decodeUnknownOption(ThreadIdsJson);
const encodeThreadIds = Schema.encodeEffect(ThreadIdsJson);
const OwnerThreadIdsJson = Schema.fromJsonString(ChatSessionOwnerThreadIds);
const decodeOwnerThreadIds = Schema.decodeUnknownOption(OwnerThreadIdsJson);
const encodeOwnerThreadIds = Schema.encodeEffect(OwnerThreadIdsJson);

export class ChatThreadSets extends Context.Service<
  ChatThreadSets,
  {
    readonly create: (
      threadIds: ChatSessionThreadIds,
      ownerThreadIds: ChatSessionOwnerThreadIds,
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

  const create = Effect.fn("ChatThreadSets.create")(function* (
    threadIds: ChatSessionThreadIds,
    ownerThreadIds: ChatSessionOwnerThreadIds,
  ) {
    const setId = yield* random.uuidV4().pipe(Effect.mapError(sqlError("ChatThreadSets.id")));
    const members = new Set(threadIds);
    const threadIdsJson = yield* encodeThreadIds([...members]).pipe(
      Effect.mapError(sqlError("ChatThreadSets.encode")),
    );
    const owners = [...new Set(ownerThreadIds)].filter((threadId) => members.has(threadId));
    const ownerThreadIdsJson =
      owners.length === 0
        ? null
        : yield* encodeOwnerThreadIds(owners).pipe(
            Effect.mapError(sqlError("ChatThreadSets.encode")),
          );
    const now = yield* DateTime.now;
    const cutoff = DateTime.subtract(now, { milliseconds: Duration.toMillis(SET_RETENTION) });
    yield* sql`DELETE FROM auth_chat_thread_sets WHERE created_at < ${DateTime.formatIso(cutoff)}`.pipe(
      Effect.mapError(sqlError("ChatThreadSets.prune")),
    );
    yield* sql`
      INSERT INTO auth_chat_thread_sets (set_id, thread_ids_json, owner_thread_ids_json, created_at)
      VALUES (${setId}, ${threadIdsJson}, ${ownerThreadIdsJson}, ${DateTime.formatIso(now)})
    `.pipe(Effect.mapError(sqlError("ChatThreadSets.create")));
    return setId;
  });

  const forSession = Effect.fn("ChatThreadSets.forSession")(function* (session: {
    readonly subject: string;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  }) {
    if (!isChatSessionScopes(session.scopes)) return undefined;
    const setId = chatSessionSetId(session.subject) ?? "";
    const rows = yield* sql<{
      readonly threadIdsJson: string;
      readonly ownerThreadIdsJson: string | null;
    }>`
      SELECT thread_ids_json AS "threadIdsJson", owner_thread_ids_json AS "ownerThreadIdsJson"
      FROM auth_chat_thread_sets WHERE set_id = ${setId}
    `.pipe(Effect.mapError(sqlError("ChatThreadSets.forSession")));
    const row = Option.fromNullishOr(rows[0]);
    const threads = new Set(
      Option.getOrElse(
        Option.flatMap(row, (found) => decodeThreadIds(found.threadIdsJson)),
        () => [],
      ),
    );
    const ownerThreadIds = Option.getOrElse(
      Option.flatMap(row, (found) =>
        found.ownerThreadIdsJson === null
          ? Option.none()
          : decodeOwnerThreadIds(found.ownerThreadIdsJson),
      ),
      () => [],
    );
    return {
      setId,
      threads,
      ownerThreads: new Set(ownerThreadIds.filter((threadId) => threads.has(threadId))),
    } satisfies ChatSession;
  });

  return ChatThreadSets.of({ create, forSession });
});

export const layer = Layer.effect(ChatThreadSets, make);
