import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest } from "effect/http";

import { descriptorDuringRecovery } from "./serviceChildTransport.ts";

import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { boundDispatchAdmission } from "./orchestration-v2/DispatchAdmissionBound.ts";

export const layerCommandReadiness = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (
        request.method === "GET" &&
        !request.headers.upgrade &&
        request.url === "/.well-known/t3/environment" &&
        descriptorDuringRecovery()
      )
        return yield* httpEffect;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      return yield* startup.awaitCommandReady.pipe(
        Effect.orDie,
        Effect.andThen(boundDispatchAdmission(httpEffect)),
      );
    }),
  { global: true },
);
