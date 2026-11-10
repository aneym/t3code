import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { EnvironmentConnectionLease, HostCheck } from "./driver.ts";
import { ConnectionTransientError, type PreparedConnection } from "./model.ts";
import type { ConnectionRouteKind } from "./routes.ts";

const RECHECK_EVERY = "1 second";
const QUIET_AFTER_MS = 6_500;
const REMOTE_QUIET_AFTER_MS = 8_000;

export const awaitDeadSocket = Effect.fn("EnvironmentSupervisor.awaitDeadSocket")(function* (
  lease: EnvironmentConnectionLease,
  routeKind: ConnectionRouteKind | undefined,
  checkHost: (prepared: PreparedConnection) => Effect.Effect<HostCheck>,
) {
  const quietAfter =
    routeKind === "loopback" || routeKind === "lan" ? QUIET_AFTER_MS : REMOTE_QUIET_AFTER_MS;
  const watchedFrom = yield* Clock.currentTimeMillis;
  const heardAt = lease.session.lastInboundAt.pipe(
    Effect.map((lastInboundAt) => Math.max(lastInboundAt, watchedFrom)),
  );
  for (;;) {
    const quietFor = (yield* Clock.currentTimeMillis) - (yield* heardAt);
    if (quietFor < quietAfter) {
      yield* Effect.sleep(Duration.millis(quietAfter - quietFor));
      continue;
    }
    const heardBefore = yield* heardAt;
    if ((yield* lease.session.lastOutboundAt) <= heardBefore) {
      yield* Effect.sleep(RECHECK_EVERY);
      continue;
    }
    const check = yield* checkHost(lease.prepared);
    if ((yield* heardAt) !== heardBefore) continue;
    if (check === "answered") return true;
    if (check === "refused") {
      return yield* new ConnectionTransientError({
        reason: "transport",
        detail: `${lease.prepared.label} stopped answering.`,
      });
    }
    yield* Effect.sleep(RECHECK_EVERY);
  }
});
