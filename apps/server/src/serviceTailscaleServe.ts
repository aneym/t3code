import { HttpServer } from "effect/http";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ServerConfig from "./config.ts";
import { pendingUpdateHandoffExists } from "./cloud/updateHandoff.ts";
import { loopbackUrlHostForAddress } from "./startupAccess.ts";
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleServeRootHolder,
  readTailscaleServeRoutesTo,
  readTailscaleStatus,
} from "@t3tools/tailscale";
export function makeTailscaleServeLayer(
  config: ServerConfig.ServerConfig["Service"],
  tailscaleParked: Deferred.Deferred<void>,
  awaitActivation: Effect.Effect<void>,
) {
  const tailscaleServeRootHolder = (target: { readonly host: string; readonly port: number }) =>
    readTailscaleServeRootHolder(config.tailscaleServePort, target);
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
            const localHost = loopbackUrlHostForAddress(address);
            const route = {
              localPort,
              urlHost: localHost,
              localHost: localHost.replace(/^\[|\]$/gu, ""),
              servePort: config.tailscaleServePort,
            };
            const holder = yield* tailscaleServeRootHolder({
              host: route.localHost,
              port: localPort,
            }).pipe(Effect.orElseSucceed(() => "unreadable" as const));
            if (holder === "other" || holder === "unreadable") {
              yield* Effect.logWarning(
                holder === "other"
                  ? "Tailscale Serve left off; its port already serves another server or app"
                  : "Tailscale Serve left off; its current routes could not be read",
                { localPort, servePort: config.tailscaleServePort },
              );
              return route;
            }
            return yield* ensureTailscaleServe({
              localPort,
              servePort: config.tailscaleServePort,
              localHost,
            }).pipe(
              Effect.as(route),
              Effect.tap(() =>
                Effect.logInfo("Tailscale Serve configured", {
                  localPort,
                  servePort: config.tailscaleServePort,
                }),
              ),
              Effect.catch((cause) =>
                Effect.logWarning(
                  cause._tag === "TailscaleCommandExitError" &&
                    cause.stderrDiagnostic === "unsupported-target"
                    ? `Tailscale Serve left off; this Tailscale install can only proxy to localhost, not ${localHost}. Bind --host 127.0.0.1 or 0.0.0.0 instead`
                    : "Failed to configure Tailscale Serve",
                  { cause, localPort, servePort: config.tailscaleServePort },
                ).pipe(Effect.as(null)),
              ),
            );
          }),
          (configured) =>
            configured
              ? pendingUpdateHandoffExists.pipe(
                  Effect.flatMap((handoff) =>
                    handoff
                      ? Effect.void
                      : Effect.all(
                          [
                            readTailscaleServeRoutesTo({
                              host: configured.localHost,
                              port: configured.localPort,
                            }),
                            readTailscaleStatus,
                          ],
                          { concurrency: 2 },
                        ).pipe(
                          // Another service may hold the root route by now, or it may sit under a
                          // former name, where `off` would act on the current one; only ours goes.
                          Effect.map(([routes, status]) =>
                            routes.some(
                              (route) =>
                                route.servePort === configured.servePort &&
                                route.mount === "/" &&
                                route.owner === undefined &&
                                route.ambiguous === undefined &&
                                route.host?.toLowerCase() === status.magicDnsName?.toLowerCase(),
                            ),
                          ),
                          Effect.orElseSucceed(() => false),
                          Effect.flatMap((ours) =>
                            ours
                              ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                                  Effect.tap(() =>
                                    Effect.logInfo("Tailscale Serve disabled", {
                                      servePort: configured.servePort,
                                    }),
                                  ),
                                )
                              : Effect.logInfo(
                                  "Tailscale Serve left on; its root route is not known to be ours",
                                  {
                                    servePort: configured.servePort,
                                  },
                                ),
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
        ).pipe(
          // Startup is not the only time the route can go stale, so whoever finds it on a dead
          // port takes it back.
          Effect.tap((configured) =>
            configured === null
              ? Effect.void
              : Effect.sleep("30 seconds").pipe(
                  Effect.andThen(
                    tailscaleServeRootHolder({
                      host: configured.localHost,
                      port: configured.localPort,
                    }),
                  ),
                  Effect.flatMap((holder) =>
                    holder === "dead"
                      ? ensureTailscaleServe({
                          localPort: configured.localPort,
                          servePort: configured.servePort,
                          localHost: configured.urlHost,
                        }).pipe(
                          Effect.andThen(
                            Effect.logInfo("Tailscale Serve repaired", {
                              localPort: configured.localPort,
                              servePort: configured.servePort,
                            }),
                          ),
                        )
                      : Effect.void,
                  ),
                  Effect.ignore,
                  Effect.forever,
                  Effect.forkScoped,
                ),
          ),
        ),
      ).pipe(Layer.provide(NetService.layer))
    : Layer.empty;
}
