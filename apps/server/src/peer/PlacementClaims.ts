import type { AgentPlacementRoom, EnvironmentId, HostResourcesSnapshot } from "@t3tools/contracts";

const CATCH_UP_MS = 120_000;
const LOAD_MS = 60_000;
const MAX_MACHINES = 256;

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
    withLoad: boolean,
  ) => {
    const { room, resources } = reading;
    const open = pending(environmentId, room, now);
    const load = withLoad
      ? recent(environmentId, now).filter((pick) => now - pick.at < LOAD_MS).length
      : 0;
    if (open.length === 0 && load === 0) return reading;
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
        load === 0 || resources == null || resources.loadAverage1m === undefined
          ? resources
          : { ...resources, loadAverage1m: resources.loadAverage1m + load },
    };
  };
  const claim = (
    environmentId: EnvironmentId,
    room: AgentPlacementRoom | undefined,
    held: boolean,
    now: number,
  ) => {
    const kept = recent(environmentId, now);
    if (picks.size >= MAX_MACHINES) for (const known of picks.keys()) recent(known, now);
    if (picks.size >= MAX_MACHINES && kept.length === 0) return;
    picks.set(environmentId, [...kept, { at: now, held, seen: counted(room) }]);
  };
  const release = (environmentId: EnvironmentId, at: number) => {
    const kept = picks.get(environmentId) ?? [];
    const index = kept.findLastIndex((pick) => pick.at === at);
    if (index < 0) return;
    const left = kept.filter((_, position) => position !== index);
    if (left.length === 0) picks.delete(environmentId);
    else picks.set(environmentId, left);
  };
  return { adjust, claim, release };
};
