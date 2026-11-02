import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest } from "effect/http";

import { servingDuringRecovery } from "./serviceChildTransport.ts";

import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

export const layerCommandReadiness = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.method === "GET" &&
        ((!request.headers.upgrade && request.url === "/.well-known/t3/environment") ||
          (request.headers.upgrade?.toLowerCase() === "websocket" &&
            request.url.split("?")[0] === "/ws")) &&
        servingDuringRecovery()
      )
        return yield* httpEffect;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      return yield* startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect));
    }),
  { global: true },
);
