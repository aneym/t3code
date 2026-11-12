import type { PlatformConnectionRegistration } from "@t3tools/client-runtime/connection";
import type * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { isElectron } from "../env";

const DESKTOP_TOPOLOGY_POLL_INTERVAL = "3 seconds";

export function platformRegistrationTicks<E, R>(
  build: Effect.Effect<ReadonlyArray<PlatformConnectionRegistration>, E, R>,
): Stream.Stream<ReadonlyArray<PlatformConnectionRegistration>, E, R> {
  const ticks = Stream.tick(DESKTOP_TOPOLOGY_POLL_INTERVAL).pipe(Stream.mapEffect(() => build));
  return isElectron
    ? ticks
    : ticks.pipe(Stream.takeUntil((registrations) => registrations.length > 0));
}
