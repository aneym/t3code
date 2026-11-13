import {
  AgentPlacementHealthLine,
  AgentPlacementProviders,
  type EnvironmentId,
  HostResourcesSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as Peers from "./PeerMcpClient.ts";

export const Snapshot = Schema.Struct({
  label: Schema.String,
  hostResources: Schema.optionalKey(Schema.NullOr(HostResourcesSnapshot)),
  placementProjectId: Schema.optionalKey(ProjectId),
  placementProjectCount: Schema.optionalKey(Schema.Number),
  placementWeight: Schema.optionalKey(Schema.Number),
  placementProviders: Schema.optionalKey(AgentPlacementProviders),
  placementHealthLine: Schema.optionalKey(AgentPlacementHealthLine),
});
export type Snapshot = typeof Snapshot.Type;

export const READ_SECONDS = 6;

export const make = Effect.fn("PlacementSnapshots.make")(function* (
  peers: Peers.PeerMcpClient["Service"],
) {
  const readGate = yield* Semaphore.make(16);
  const snapshotScope = yield* Scope.Scope;
  const pending = new Map<string, Fiber.Fiber<void>>();
  const snapshots = new Map<
    string,
    { expiresAt: number; value: Snapshot | undefined; failure: string | undefined }
  >();
  const cached = (environmentId: EnvironmentId, keys: ReadonlyArray<string>, now: number) => {
    const entry = snapshots.get(`${environmentId}:${keys.join(" ")}`);
    return entry !== undefined && entry.expiresAt > now ? entry : undefined;
  };
  const refresh = Effect.fn("PlacementSnapshots.refresh")(function* (input: {
    readonly environmentIds: ReadonlyArray<EnvironmentId>;
    readonly keys: ReadonlyArray<string>;
    readonly limits: Peers.PeerCallLimits;
    readonly now: number;
  }) {
    const reads = yield* Effect.forEach(input.environmentIds, (environmentId) =>
      Effect.gen(function* () {
        const snapshotKey = `${environmentId}:${input.keys.join(" ")}`;
        const entry = snapshots.get(snapshotKey);
        if (entry !== undefined && entry.expiresAt > input.now) return undefined;
        const existing = pending.get(snapshotKey);
        if (existing !== undefined) return existing;
        const read = peers
          .call({
            environmentId,
            tool: "t3_environment_read",
            arguments: {
              placementRepositoryKey: input.keys[0],
              placementRepositoryKeys: input.keys,
              includePlacementProviders: true,
            },
            limits: input.limits,
            success: Snapshot,
          })
          .pipe(
            readGate.withPermits(1),
            Effect.timeoutOption(`${READ_SECONDS} seconds`),
            Effect.map((value) =>
              Option.isSome(value)
                ? { value: value.value, failure: undefined }
                : { value: undefined, failure: `No reply within ${READ_SECONDS} s.` },
            ),
            Effect.catch((error) =>
              Effect.succeed({ value: undefined, failure: `Read failed: ${error.message}` }),
            ),
            Effect.flatMap((result) =>
              DateTime.now.pipe(
                Effect.map((sampledAt) => {
                  if (snapshots.size >= 128) snapshots.clear();
                  snapshots.set(snapshotKey, {
                    ...result,
                    expiresAt:
                      DateTime.toEpochMillis(sampledAt) +
                      (result.failure === undefined ? 5000 : 30_000),
                  });
                }),
              ),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(snapshotKey);
              }),
            ),
          );
        const fiber = yield* read.pipe(Effect.forkIn(snapshotScope));
        pending.set(snapshotKey, fiber);
        return fiber;
      }),
    );
    yield* Fiber.joinAll(reads.filter((fiber) => fiber !== undefined)).pipe(
      Effect.timeout(`${READ_SECONDS * 1000 + 500} millis`),
      Effect.ignore,
    );
  });
  return { cached, refresh };
});
