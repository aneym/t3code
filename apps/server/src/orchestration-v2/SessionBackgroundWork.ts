import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProviderSessionManagerV2Shape } from "./ProviderSessionManager.ts";

export const sessionHasBackgroundWork = Effect.fn("Orchestrator.sessionHasBackgroundWork")(
  function* (
    providerSessions: Pick<ProviderSessionManagerV2Shape, "get">,
    detaching: OrchestrationV2ThreadProjection["providerSessions"][number],
    providerThreads: OrchestrationV2ThreadProjection["providerThreads"],
  ) {
    const session = yield* providerSessions
      .get(detaching.id)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(session)) return false;
    const runtime = session.value;
    const probes =
      !detaching.capabilities.sessions.supportsMultipleProviderThreadsPerSession &&
      runtime.hasPendingBackgroundWork !== undefined
        ? [runtime.hasPendingBackgroundWork]
        : providerThreads.flatMap((providerThread) =>
            providerThread.providerSessionId === detaching.id &&
            runtime.hasPendingBackgroundWorkForThread !== undefined
              ? [runtime.hasPendingBackgroundWorkForThread(providerThread)]
              : [],
          );
    for (const probe of probes) {
      if (yield* probe.pipe(Effect.catchCause(() => Effect.succeed(true)))) return true;
    }
    return false;
  },
);
