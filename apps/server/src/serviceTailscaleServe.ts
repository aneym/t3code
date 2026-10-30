import { HttpServer } from "effect/http";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ServerConfig from "./config.ts";
import { pendingUpdateHandoffExists } from "./cloud/updateHandoff.ts";
import { loopbackUrlHostForAddress } from "./startupAccess.ts";
import { disableTailscaleServe, ensureTailscaleServe } from "@t3tools/tailscale";
export function makeTailscaleServeLayer(
  config: ServerConfig.ServerConfig["Service"],
  tailscaleParked: Deferred.Deferred<void>,
  awaitActivation: Effect.Effect<void>,
) {
  return config.tailscaleServeEnabled
    ? Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.gen(function* () {
            yield* Deferred.succeed(tailscaleParked, undefined).pipe(Effect.orDie);
            yield* awaitActivation;
            const server = yield* HttpServer.HttpServer;
            const address = server.address;
            if (typeof address === "string" || !("port" in address)) {
              return null;
            }

            const localPort = address.port;
            return yield* ensureTailscaleServe({
              localPort,
              servePort: config.tailscaleServePort,
              localHost: loopbackUrlHostForAddress(address),
            }).pipe(
              Effect.as({ localPort, servePort: config.tailscaleServePort }),
              Effect.tap(() =>
                Effect.logInfo("Tailscale Serve configured", {
                  localPort,
                  servePort: config.tailscaleServePort,
                }),
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Failed to configure Tailscale Serve", {
                  cause,
                  localPort,
                  servePort: config.tailscaleServePort,
                }).pipe(Effect.as(null)),
              ),
            );
          }),
          (configured) =>
            configured
              ? pendingUpdateHandoffExists.pipe(
                  Effect.flatMap((handoff) =>
                    handoff
                      ? Effect.void
                      : disableTailscaleServe({ servePort: configured.servePort }).pipe(
                          Effect.tap(() =>
                            Effect.logInfo("Tailscale Serve disabled", {
                              servePort: configured.servePort,
                            }),
                          ),
                          Effect.catch((cause) =>
                            Effect.logWarning("Failed to disable Tailscale Serve", {
                              cause,
                              servePort: configured.servePort,
                            }),
                          ),
                        ),
                  ),
                )
              : Effect.void,
        ),
      )
    : Layer.empty;
}
