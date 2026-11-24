import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  presentConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { embedFailureCodes } from "../../embed/embedFailureCodes";
import { embedConnectionRefused } from "../../embed/embedKeptViewGate";
import { useConnectionOutage } from "../../hooks/useConnectionOutage";

export function EmbedConnectionNotice({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const state = AsyncResult.getOrElse(
    useAtomValue(environmentCatalog.stateAtom(environmentId)),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const blocked = state.phase === "blocked";
  const refused = embedConnectionRefused(state);
  const outage = useConnectionOutage(environmentId, presentConnectionState(state).phase);
  const failing = blocked || outage.loud;
  const detail = state.lastFailure?.message ?? null;
  const attempt = state.attempt;
  const codes = JSON.stringify(embedFailureCodes(state.lastFailure));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- names each failed attempt in the console once
  useEffect(() => {
    if (!failing) return;
    console.warn(`[embed-connection] problem, attempt ${attempt}: ${codes}`);
  }, [failing, attempt, codes]);
  if (!failing) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 border-b bg-background px-4 py-2 text-center text-sm"
    >
      <p className="font-medium text-foreground">
        {refused ? "Sign in needed" : "Connection problem"}
      </p>
      <p className="text-muted-foreground">
        {refused
          ? "This chat's computer no longer accepts this page's sign-in."
          : blocked
            ? (detail ?? "This chat can't reach its server.")
            : `The connection to this chat keeps dropping. Reconnecting, try ${attempt}.`}
      </p>
      {!blocked && detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}
