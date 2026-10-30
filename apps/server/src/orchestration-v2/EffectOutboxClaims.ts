import type * as SqlClient from "effect/sql/SqlClient";

import { RESTART_DRAIN_HELD_EFFECT_TYPES } from "./EffectOutboxModel.ts";

// Retry backoff must block later effects so turns cannot race a pending rollback.
export const claimableCandidatePredicate = (
  sql: SqlClient.SqlClient,
  input: {
    readonly availableBefore?: string;
    readonly excludeRestartContinuations?: boolean;
    readonly draining: boolean;
  },
) => sql`
  ${
    input.availableBefore === undefined
      ? sql`1 = 1`
      : sql`candidate.available_at <= ${input.availableBefore}`
  }
  AND candidate.status = 'pending'
  AND ${
    input.draining
      ? sql`candidate.effect_type NOT IN ${sql.in(RESTART_DRAIN_HELD_EFFECT_TYPES)}`
      : sql`1 = 1`
  }
  AND NOT EXISTS (
    SELECT 1
    FROM orchestration_v2_effect_outbox AS active
    WHERE active.thread_id = candidate.thread_id
      AND (
        active.status = 'running'
        OR (
          active.status = 'pending'
          AND active.rowid < candidate.rowid
          AND ${
            input.excludeRestartContinuations === true
              ? sql`active.effect_type != 'provider-runtime.continue'`
              : sql`1 = 1`
          }
        )
      )
      AND (
        (
          candidate.effect_type = 'thread-title.generate'
          AND active.effect_type = 'thread-title.generate'
        )
        OR
        (
          candidate.effect_type != 'thread-title.generate'
          AND active.effect_type != 'thread-title.generate'
        )
      )
  )
`;
