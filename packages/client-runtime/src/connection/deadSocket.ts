import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { EnvironmentConnectionLease, HostCheck } from "./driver.ts";
import { ConnectionTransientError, type PreparedConnection } from "./model.ts";
import type { ConnectionRouteKind } from "./routes.ts";

const CHECK_EVERY = "1 second";
const QUIET_AFTER_MS = 6_500;
const REMOTE_QUIET_AFTER_MS = 8_000;

export const awaitDeadSocket = Effect.fn("EnvironmentSupervisor.awaitDeadSocket")(function* (
  lease: EnvironmentConnectionLease,
  routeKind: ConnectionRouteKind | undefined,
  checkHost: (prepared: PreparedConnection) => Effect.Effect<HostCheck>,
) {
  const quietAfter =
    routeKind === "loopback" || routeKind === "lan" ? QUIET_AFTER_MS : REMOTE_QUIET_AFTER_MS;
  let frames = yield* lease.session.inboundFrames;
  let heardAt = yield* Clock.currentTimeMillis;
  for (;;) {
    yield* Effect.sleep(CHECK_EVERY);
    const latest = yield* lease.session.inboundFrames;
    const now = yield* Clock.currentTimeMillis;
    if (latest !== frames) {
      frames = latest;
      heardAt = now;
      continue;
    }
    if (now - heardAt < quietAfter) continue;
    const check = yield* checkHost(lease.prepared);
    if ((yield* lease.session.inboundFrames) !== frames) continue;
    if (check === "answered") return true;
    if (check === "refused") {
      return yield* new ConnectionTransientError({
        reason: "transport",
        detail: `${lease.prepared.label} stopped answering.`,
      });
    }
  }
});
