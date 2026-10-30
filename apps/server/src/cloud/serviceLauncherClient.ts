import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import packageJson from "../../package.json" with { type: "json" };
import {
  decodeServiceLauncherContext,
  decodeServiceLauncherParentMessage,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
} from "./serviceProtocol.ts";

export {
  ServiceLauncherClientError,
  ServiceLauncherRejectedError,
} from "./serviceLauncherErrors.ts";
import {
  ServiceLauncherClientError,
  ServiceLauncherRejectedError,
} from "./serviceLauncherErrors.ts";
import { hotSwapContext, prepareServiceRouting } from "../serviceChildTransport.ts";

interface ServiceLauncherProcess {
  readonly connected: boolean;
  readonly send: (
    message: ServiceLauncherChildMessage,
    callback?: (error: Error | null) => void,
  ) => boolean;
  readonly on: (
    event: "message" | "disconnect",
    listener: (...args: ReadonlyArray<unknown>) => void,
  ) => void;
  readonly off: (
    event: "message" | "disconnect",
    listener: (...args: ReadonlyArray<unknown>) => void,
  ) => void;
}

export const ServiceLauncherHostProcess = Context.Reference<ServiceLauncherProcess>(
  "t3/cloud/serviceLauncherHostProcess",
  {
    defaultValue: () => ({
      connected: process.connected && process.send !== undefined,
      send: (message, callback) => {
        if (process.send === undefined) return false;
        return callback === undefined ? process.send(message) : process.send(message, callback);
      },
      on: (event, listener) => {
        process.on(event, listener);
      },
      off: (event, listener) => {
        process.off(event, listener);
      },
    }),
  },
);

export class ServiceLauncherClient extends Context.Service<
  ServiceLauncherClient,
  {
    readonly managed: boolean;
    readonly requestUpdate: (input: {
      readonly targetVersion: string;
      readonly dbPath: string;
      readonly allowDowngrade?: boolean;
    }) => Effect.Effect<string, ServiceLauncherClientError | ServiceLauncherRejectedError>;
    readonly prepareTrial: Effect.Effect<
      ServerSelfUpdateOutcome | undefined,
      ServiceLauncherClientError
    >;
  }
>()("t3/cloud/serviceLauncherClient") {}

const resolveStartup = Effect.fn("cloud.service_launcher_client.resolve_startup")(
  function* (options?: { readonly currentVersion?: string }) {
    const host = yield* ServiceLauncherHostProcess;
    const environment = yield* HostProcess.Environment;
    const currentVersion = options?.currentVersion ?? packageJson.version;
    // IPC channels are not inherited; without one, launcher context belongs to an ancestor.
    const rawContext = host.connected ? environment[SERVICE_LAUNCHER_CONTEXT_ENV] : undefined;
    const context = rawContext === undefined ? undefined : decodeServiceLauncherContext(rawContext);

    if (rawContext !== undefined && context === undefined) {
      return yield* new ServiceLauncherClientError({ operation: "decode-context" });
    }
    if (context !== undefined && context.childVersion !== currentVersion) {
      return yield* new ServiceLauncherClientError({ operation: "version-mismatch" });
    }

    const managed = context !== undefined;

    return { host, context, managed };
  },
);

export const resolveServiceLauncherMode = Effect.fn("cloud.service_launcher_client.resolve_mode")(
  function* () {
    const { managed } = yield* resolveStartup();
    return { managed };
  },
);

export const make = Effect.fn("cloud.service_launcher_client.make")(function* (options?: {
  readonly currentVersion?: string;
}) {
  const { host, context, managed } = yield* resolveStartup(options);

  const exchange = (
    message: ServiceLauncherChildMessage,
    accept: (reply: ServiceLauncherParentMessage) => boolean,
  ) =>
    Effect.callback<ServiceLauncherParentMessage, ServiceLauncherClientError>((resume) => {
      if (!managed) {
        resume(Effect.fail(new ServiceLauncherClientError({ operation: "unmanaged" })));
        return;
      }

      let settled = false;
      const cleanup = () => {
        host.off("message", onMessage);
        host.off("disconnect", onDisconnect);
      };
      const settle = (
        effect: Effect.Effect<ServiceLauncherParentMessage, ServiceLauncherClientError>,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(effect);
      };
      const onMessage = (...args: ReadonlyArray<unknown>) => {
        const reply = decodeServiceLauncherParentMessage(args[0]);
        if (reply !== undefined && accept(reply)) settle(Effect.succeed(reply));
      };
      const onDisconnect = () =>
        settle(Effect.fail(new ServiceLauncherClientError({ operation: "disconnect" })));

      host.on("message", onMessage);
      host.on("disconnect", onDisconnect);
      try {
        host.send(message, (error) => {
          if (error !== null) {
            settle(
              Effect.fail(new ServiceLauncherClientError({ operation: "send", cause: error })),
            );
          }
        });
      } catch (cause) {
        settle(Effect.fail(new ServiceLauncherClientError({ operation: "send", cause })));
      }

      return Effect.sync(cleanup);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(new ServiceLauncherClientError({ operation: "timeout" })),
      }),
    );

  const requestUpdate = (input: {
    readonly targetVersion: string;
    readonly dbPath: string;
    readonly allowDowngrade?: boolean;
  }) =>
    exchange(
      { type: "request-update", ...input },
      (reply) => reply.type === "update-accepted" || reply.type === "update-rejected",
    ).pipe(
      Effect.flatMap((reply) =>
        reply.type === "update-accepted"
          ? Effect.succeed(reply.updateId)
          : reply.type === "update-rejected"
            ? Effect.fail(
                new ServiceLauncherRejectedError({
                  targetVersion: input.targetVersion,
                  reason: reply.reason,
                }),
              )
            : Effect.die("service launcher returned an impossible update response"),
      ),
    );

  const pending = context?.update?.status === "pending" ? context.update : undefined;
  const outcome =
    context?.update === undefined || context.update.status === "pending"
      ? undefined
      : context.update;
  const prepareTrial =
    pending !== undefined
      ? exchange(
          { type: "prepared", updateId: pending.id },
          (reply) => reply.type === "committed" && reply.updateId === pending.id,
        ).pipe(
          Effect.flatMap((reply) => {
            if (reply.type !== "committed") {
              return Effect.die("service launcher returned an impossible prepared response");
            }
            return Effect.succeed({
              id: pending.id,
              fromVersion: pending.fromVersion,
              targetVersion: pending.targetVersion,
              status: "committed" as const,
            });
          }),
        )
      : Effect.succeed(outcome);

  return ServiceLauncherClient.of({
    managed,
    requestUpdate,
    prepareTrial: hotSwapContext() === undefined ? prepareTrial : prepareServiceRouting(),
  });
});

export const layer = Layer.effect(ServiceLauncherClient, make());
