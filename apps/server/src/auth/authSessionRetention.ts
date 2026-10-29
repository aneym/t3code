import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as SessionStore from "./SessionStore.ts";

const AUTH_SESSION_RETENTION_GRACE = Duration.days(1);
const PRUNE_BATCH_SIZE = 500;
const PRUNE_BATCH_PAUSE = Duration.millis(200);
const PRUNE_STARTUP_DELAY = Duration.minutes(1);

type PrunedKind = "revoked" | "expired";

const deleteBatch = Effect.fn("authSessionRetention.deleteBatch")(function* (
  kind: PrunedKind,
  cutoff: string,
  connected: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ sessionId: string }>`
    DELETE FROM auth_sessions
    WHERE session_id IN (
      SELECT session_id FROM auth_sessions
      WHERE ${
        kind === "revoked"
          ? sql`revoked_at < ${cutoff}`
          : sql`revoked_at IS NULL AND expires_at < ${cutoff}`
      }
      ${connected.length > 0 ? sql`AND NOT ${sql.in("session_id", connected)}` : sql``}
      LIMIT ${PRUNE_BATCH_SIZE}
    )
    RETURNING session_id AS "sessionId"
  `;
  return rows.length;
});

const pruneKind = Effect.fn("authSessionRetention.pruneKind")(function* (
  kind: PrunedKind,
  cutoff: string,
  connected: ReadonlyArray<string>,
) {
  let total = 0;
  while (true) {
    const deleted = yield* deleteBatch(kind, cutoff, connected);
    total += deleted;
    if (deleted < PRUNE_BATCH_SIZE) return total;
    yield* Effect.sleep(PRUNE_BATCH_PAUSE);
  }
});

const pruneAuthSessions = Effect.fn("authSessionRetention.prune")(function* () {
  const cutoff = DateTime.formatIso(
    DateTime.subtract(yield* DateTime.now, {
      milliseconds: Duration.toMillis(AUTH_SESSION_RETENTION_GRACE),
    }),
  );
  const sessions = yield* SessionStore.SessionStore;
  const connected = (yield* sessions.listActive())
    .filter((session) => session.connected)
    .map((session) => session.sessionId);
  const revoked = yield* pruneKind("revoked", cutoff, []);
  const expired = yield* pruneKind("expired", cutoff, connected);
  yield* Effect.annotateCurrentSpan({
    "auth_sessions.pruned_revoked": revoked,
    "auth_sessions.pruned_expired": expired,
  });
  if (revoked + expired > 0) {
    yield* Effect.logInfo("Pruned stale auth sessions", { revoked, expired });
  }
  return { revoked, expired };
});

export const layer = Layer.effectDiscard(
  forkParked(
    Effect.sleep(PRUNE_STARTUP_DELAY).pipe(
      Effect.andThen(
        pruneAuthSessions().pipe(
          Effect.catch((cause) => Effect.logWarning("Failed to prune auth sessions", { cause })),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
        ),
      ),
    ),
  ),
);
