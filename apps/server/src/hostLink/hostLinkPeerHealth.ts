import type {
  HostLinkPeerDownReason,
  HostLinkPeerHealth,
  PeerLinkStatus,
} from "@t3tools/contracts";

const MISSES_BEFORE_DOWN = 2;

export interface PeerObservation {
  readonly environmentId: string;
  readonly label: string;
  readonly status: PeerLinkStatus;
}

export interface PeerHealthChange {
  readonly kind: "peer_down" | "peer_up";
  readonly at: string;
  readonly data: Record<string, unknown>;
}

interface Tracked {
  health: HostLinkPeerHealth | null;
  misses: number;
}

export const makePeerHealthTracker = () => {
  const tracked = new Map<string, Tracked>();

  const observe = (
    observations: ReadonlyArray<PeerObservation>,
    at: string,
  ): ReadonlyArray<PeerHealthChange> => {
    const changes: Array<PeerHealthChange> = [];
    const seen = new Set<string>();
    for (const { environmentId, label, status } of observations) {
      seen.add(environmentId);
      const entry = tracked.get(environmentId) ?? { health: null, misses: 0 };
      tracked.set(environmentId, entry);
      const previous = entry.health;
      if (status === "reachable") {
        entry.misses = 0;
        if (previous?.state === "up") {
          entry.health = { ...previous, label };
          continue;
        }
        entry.health = { environmentId, label, state: "up", reason: null, since: at };
        if (previous !== null) {
          changes.push({
            kind: "peer_up",
            at,
            data: { environmentId, label, downSince: previous.since, reason: previous.reason },
          });
        }
        continue;
      }
      entry.misses += 1;
      const reason: HostLinkPeerDownReason = status;
      if (reason === "unreachable" && entry.misses < MISSES_BEFORE_DOWN) continue;
      if (previous?.state === "down" && previous.reason === reason) {
        entry.health = { ...previous, label };
        continue;
      }
      entry.health = { environmentId, label, state: "down", reason, since: at };
      changes.push({
        kind: "peer_down",
        at,
        data: {
          environmentId,
          label,
          reason,
          upSince: previous?.state === "up" ? previous.since : null,
        },
      });
    }
    for (const environmentId of tracked.keys()) {
      if (!seen.has(environmentId)) tracked.delete(environmentId);
    }
    return changes;
  };

  const snapshot = (): ReadonlyArray<HostLinkPeerHealth> =>
    [...tracked.values()].flatMap((entry) => (entry.health === null ? [] : [entry.health]));

  return { observe, snapshot };
};
