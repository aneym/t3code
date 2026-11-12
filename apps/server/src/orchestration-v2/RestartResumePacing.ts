import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  RESTART_RESUME_EFFECT_TYPES,
  RESTART_RESUME_SPACING_MS,
  type OrchestrationEffectV2,
} from "./EffectOutboxModel.ts";

const resumesRuns = (effect: OrchestrationEffectV2) =>
  effect.request.type === "provider-runtime.continue" ||
  (effect.request.type === "provider-runtime.restart-handoff" &&
    effect.request.handoff.runIds.length > 0);

export const paceRestartResumes = (
  sql: SqlClient.SqlClient,
  claimed: OrchestrationEffectV2,
  now: DateTime.DateTime,
) => {
  if (!resumesRuns(claimed)) return Effect.void;
  const spacedUntil = DateTime.makeUnsafe(DateTime.toEpochMillis(now) + RESTART_RESUME_SPACING_MS);
  return sql`
    UPDATE orchestration_v2_effect_outbox
    SET available_at = MAX(available_at, ${DateTime.formatIso(spacedUntil)})
    WHERE status = 'pending' AND effect_type IN ${sql.in(RESTART_RESUME_EFFECT_TYPES)}
  `.pipe(Effect.asVoid);
};
