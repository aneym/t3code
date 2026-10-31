import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/http";

import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

export const layerCommandReadiness = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(ServerRuntimeStartup.ServerRuntimeStartup, (startup) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
    ),
  { global: true },
);
