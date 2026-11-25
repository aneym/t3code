import type { AgentPlacementRoom, EnvironmentId, HostResourcesSnapshot } from "@t3tools/contracts";

const CATCH_UP_MS = 120_000;

interface Pick {
  readonly at: number;
  readonly held: boolean;
  readonly seen: number | undefined;
}

const counted = (room: AgentPlacementRoom | undefined) =>
  room === undefined ? undefined : room.active + room.held;

export const make = () => {
  const picks = new Map<EnvironmentId, Array<Pick>>();
  const recent = (environmentId: EnvironmentId, now: number) => {
    const kept = (picks.get(environmentId) ?? []).filter((pick) => now - pick.at < CATCH_UP_MS);
    if (kept.length === 0) picks.delete(environmentId);
    else picks.set(environmentId, kept);
    return kept;
  };
  const pending = (
    environmentId: EnvironmentId,
    room: AgentPlacementRoom | undefined,
    now: number,
  ) => {
    const kept = recent(environmentId, now);
    const first = kept[0]?.seen;
    const reading = counted(room);
    const absorbed =
      first === undefined || reading === undefined ? 0 : Math.max(0, reading - first);
    return kept.slice(absorbed);
  };
  const adjust = (
    environmentId: EnvironmentId,
    reading: {
      readonly room: AgentPlacementRoom | undefined;
      readonly resources: HostResourcesSnapshot | null | undefined;
    },
    now: number,
  ) => {
    const { room, resources } = reading;
    const open = pending(environmentId, room, now);
    if (open.length === 0) return reading;
    const held = open.filter((pick) => pick.held).length;
    const active = open.length - held;
    return {
      room:
        room === undefined
          ? undefined
          : {
              ...room,
              active: room.active + active,
              held: room.held + held,
              free: room.free === null ? null : Math.max(0, room.free - active),
            },
      resources:
        resources == null || resources.loadAverage1m === undefined
          ? resources
          : { ...resources, loadAverage1m: resources.loadAverage1m + open.length },
    };
  };
  const claim = (
    environmentId: EnvironmentId,
    room: AgentPlacementRoom | undefined,
    held: boolean,
    now: number,
  ) => {
    const kept = recent(environmentId, now);
    if (picks.size >= 256 && kept.length === 0) picks.clear();
    picks.set(environmentId, [...kept, { at: now, held, seen: counted(room) }]);
  };
  return { adjust, claim };
};
