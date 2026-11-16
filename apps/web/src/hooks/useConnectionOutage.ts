import {
  type EnvironmentConnectionPhase,
  restartAnnouncementDeadline,
  subscribeRestartNotices,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";

import { useDeadlinePassed } from "./useDeadline";

const QUIET_MS = 3_000;
const REAL_OUTAGE_MS = 30_000;
const STABLE_MS = 5_000;

type OutageKind = "down" | "up" | "blocked" | "idle";

interface OutageClock {
  readonly environmentId: EnvironmentId | null;
  readonly kind: OutageKind;
  readonly since: number | null;
  readonly connectedAt: number | null;
}

function outageKind(phase: EnvironmentConnectionPhase): OutageKind {
  switch (phase) {
    case "connecting":
    case "reconnecting":
    case "offline":
      return "down";
    case "connected":
      return "up";
    case "error":
    case "unsupported":
      return "blocked";
    case "available":
      return "idle";
  }
}

function advance(
  previous: OutageClock | null,
  environmentId: EnvironmentId | null,
  kind: OutageKind,
): OutageClock {
  const now = Date.now();
  if (previous === null || previous.environmentId !== environmentId || kind === "idle") {
    return {
      environmentId,
      kind,
      since: kind === "down" ? now : null,
      connectedAt: kind === "up" ? now : null,
    };
  }
  if (kind === "up") return { ...previous, kind, connectedAt: now };
  const heldUp =
    previous.kind === "up" &&
    previous.connectedAt !== null &&
    now - previous.connectedAt >= STABLE_MS;
  return {
    environmentId,
    kind,
    since: previous.since === null || heldUp ? now : previous.since,
    connectedAt: null,
  };
}

export function useConnectionOutage(
  environmentId: EnvironmentId | null,
  phase: EnvironmentConnectionPhase,
) {
  const kind = outageKind(phase);
  const [clock, setClock] = useState(() => advance(null, environmentId, kind));
  if (clock.environmentId !== environmentId || clock.kind !== kind) {
    setClock((previous) => advance(previous, environmentId, kind));
  }
  const announcedUntil = useSyncExternalStore(subscribeRestartNotices, () =>
    environmentId === null ? null : restartAnnouncementDeadline(environmentId),
  );
  const since = clock.kind === "down" ? clock.since : null;
  const quiet = useDeadlinePassed(since === null ? null : since + QUIET_MS);
  const long = useDeadlinePassed(
    since === null ? null : Math.max(since + REAL_OUTAGE_MS, announcedUntil ?? 0),
  );
  return {
    reconnecting: since !== null && quiet && !long,
    loud: kind === "blocked" || long,
  };
}
