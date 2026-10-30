import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import { writeConnectorConfig } from "./connectorConfig.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type {
  CloudManagedEndpointRuntime,
  CloudManagedEndpointRuntimeStatus,
} from "./ManagedEndpointRuntime.ts";
import { pendingUpdateHandoffExists } from "./updateHandoff.ts";
import * as ServerConfig from "../config.ts";

const Config = Schema.NullOr(Schema.Struct({ executable: Schema.String, token: Schema.String }));

const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(Config));

const Status = Schema.Struct({
  pid: Schema.NullOr(Schema.Number),
  facts: Schema.NullOr(
    Schema.Struct({
      readyConnections: Schema.NullOr(Schema.Number),
      hostname: Schema.NullOr(Schema.String),
      protocol: Schema.NullOr(Schema.String),
    }),
  ),
});

export const makeLauncherEndpointRuntime = Effect.fn("ServiceEndpointRuntime.make")(function* () {
  const relayClient = yield* RelayClient.RelayClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const directory = path.join(baseDir, "runtime");
  const configPath = path.join(directory, "connector-config.json");
  const readStatus = fs.readFileString(path.join(directory, "connector-status.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Status))),
    Effect.orElseSucceed(() => ({ pid: null, facts: null })),
  );
  const recovery = yield* Queue.sliding<RelayManagedEndpointRuntimeConfig>(1);
  const readiness = yield* Queue.sliding<void>(1);
  const connected = yield* Queue.sliding<void>(1);
  const lock = yield* Semaphore.make(1);
  const desired = yield* Ref.make<RelayManagedEndpointRuntimeConfig | null>(null);
  const applyConfig = Effect.fn("ServiceEndpointRuntime.applyConfig")(function* (
    config: RelayManagedEndpointRuntimeConfig | null,
  ): Effect.fn.Return<CloudManagedEndpointRuntimeStatus> {
    yield* Ref.set(desired, config);
    let executable = config === null ? undefined : yield* relayClient.resolve;
    if (config !== null && executable?.status !== "available") {
      const installed = yield* relayClient.install.pipe(Effect.option);
      if (Option.isSome(installed)) executable = installed.value;
    }
    if (config !== null && executable?.status !== "available")
      return {
        status: "failed",
        providerKind: config.providerKind,
        failure: "not-installed",
        reason: "The relay client is not installed.",
      };
    const contents = yield* encodeConfig(
      config !== null && executable?.status === "available"
        ? { executable: executable.executablePath, token: config.connectorToken }
        : null,
    ).pipe(Effect.orDie);
    const previous = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
    if (previous !== contents) {
      const written = yield* fs
        .makeDirectory(directory, { recursive: true })
        .pipe(
          Effect.andThen(
            writeConnectorConfig(configPath, contents).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            ),
          ),
          Effect.option,
        );
      if (written._tag === "None")
        return {
          status: "failed",
          providerKind: "cloudflare_tunnel",
          failure: "spawn-failed",
          reason: "Could not update the connector service configuration.",
        };
    }
    yield* Queue.offer(readiness, undefined);
    if (config === null) return { status: "disabled" };
    const status = yield* readStatus;
    return status.pid === null
      ? {
          status: "failed",
          providerKind: config.providerKind,
          failure: "spawn-failed",
          reason: "The connector service is starting.",
        }
      : {
          status: "running",
          providerKind: "cloudflare_tunnel",
          pid: status.pid,
          ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
          ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
        };
  });
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("30 seconds");
        const config = yield* Ref.get(desired);
        if (config === null) return;
        const status = yield* readStatus;
        yield* Queue.offer(readiness, undefined);
        if (status.facts?.readyConnections === 0) yield* Queue.offer(recovery, config);
        else if (
          status.facts?.readyConnections !== null &&
          status.facts !== null &&
          status.facts.readyConnections > 0
        )
          yield* Queue.offer(connected, undefined);
      }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    pendingUpdateHandoffExists.pipe(
      Effect.flatMap((handoff) => (handoff ? Effect.void : applyConfig(null))),
    ),
  );
  return {
    applyConfig,
    inspectConnector: readStatus.pipe(Effect.map((status) => status.facts)),
    readinessChanged: Stream.fromQueue(readiness),
    recoveryRequests: Stream.fromQueue(recovery),
    tunnelConnected: Stream.fromQueue(connected),
    requestRecovery: Effect.fn("ServiceEndpointRuntime.requestRecovery")(
      (config: RelayManagedEndpointRuntimeConfig) =>
        Queue.offer(recovery, config).pipe(Effect.asVoid),
    ),
    withLinkStateLock: lock.withPermits(1),
  } satisfies CloudManagedEndpointRuntime["Service"];
});
