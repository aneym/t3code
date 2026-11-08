// @effect-diagnostics-next-line nodeBuiltinImport:off -- The boot id and token fingerprint need random bytes and a digest.
import * as NodeCrypto from "node:crypto";

import {
  HOST_LINK_PROTOCOL,
  type HostLinkBindResult,
  HostLinkInboundFrame,
  type HostLinkLane,
  type HostLinkStatus,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HostLinkCoalescer } from "./HostLinkCoalescer.ts";
import { type HostLinkConnection, makeHostLinkConnection } from "./HostLinkConnection.ts";
import { type HostLinkThreadEvent, makeHostLinkEventMapper } from "./hostLinkEvents.ts";
import { readHostLinkToken } from "./hostLinkToken.ts";
import * as LaneStore from "./HostLinkLaneStore.ts";

const RECONCILE_EVERY = "60 seconds";
const COALESCE_EVERY = "250 millis";

const decodeInbound = Schema.decodeUnknownOption(HostLinkInboundFrame);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const failure = (
  code: "invalid_request" | "thread_not_found" | "orchestration_error",
  message: string,
) => new OrchestratorMcpFailure({ code, message });

export class HostLinkService extends Context.Service<
  HostLinkService,
  {
    readonly bind: (input: {
      readonly threadId: ThreadId;
      readonly lane: HostLinkLane | null;
    }) => Effect.Effect<HostLinkBindResult, OrchestratorMcpFailure>;
    readonly status: (input: {
      readonly threadId?: ThreadId;
    }) => Effect.Effect<HostLinkStatus, OrchestratorMcpFailure>;
  }
>()("t3/hostLink/HostLinkService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const context = yield* Effect.context<
    SqlClient.SqlClient | ThreadManagementService.ThreadManagementService
  >();
  const runFork = Effect.runForkWith(context);
  const bootId = NodeCrypto.randomBytes(8).toString("hex");
  const environmentId = yield* environment.getEnvironmentId;
  const lanes = new Map<string, { readonly lane: string; readonly boundAt: string }>();
  for (const binding of yield* LaneStore.listLanes().pipe(Effect.provide(context))) {
    lanes.set(binding.threadId, { lane: binding.lane, boundAt: binding.boundAt });
  }

  let connection: HostLinkConnection | null = null;
  let seq = 0;
  const nextSeq = () => ++seq;
  let connectionKey = "";
  const coalescer = new HostLinkCoalescer((frame) => connection?.sendEvent(frame));

  const laneList = () => [...lanes].map(([threadId, value]) => ({ threadId, lane: value.lane }));

  const push = (event: HostLinkThreadEvent) => {
    if (connection === null) return;
    const bound = lanes.get(event.threadId);
    if (bound === undefined) return;
    coalescer.push(event, {
      at: event.at,
      threadId: event.threadId,
      lane: bound.lane,
      kind: event.kind,
      data: event.data,
    });
    if (event.kind === "ended" && event.data.reason === "deleted") {
      lanes.delete(event.threadId);
      runFork(LaneStore.unbindLane(event.threadId).pipe(Effect.ignore));
    }
  };

  const lifecycle = yield* Semaphore.make(1);

  const bind = Effect.fn("HostLinkService.bind")(
    function* (input: { readonly threadId: ThreadId; readonly lane: HostLinkLane | null }) {
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null)
        return yield* failure("thread_not_found", `Thread ${input.threadId} not found.`);
      if (input.lane === null) {
        yield* LaneStore.unbindLane(input.threadId);
        lanes.delete(input.threadId);
        return { threadId: input.threadId, lane: null };
      }
      const boundAt = DateTime.formatIso(yield* DateTime.now);
      yield* LaneStore.bindLane({ threadId: input.threadId, lane: input.lane, boundAt });
      lanes.set(input.threadId, { lane: input.lane, boundAt });
      return { threadId: input.threadId, lane: input.lane };
    },
    Effect.mapError((error) =>
      isMcpFailure(error)
        ? error
        : failure("orchestration_error", "Could not store the thread's lane."),
    ),
    lifecycle.withPermits(1),
    Effect.provide(context),
  );

  const onFrame = (raw: unknown) => {
    const frame = Option.getOrUndefined(decodeInbound(raw));
    if (frame === undefined) return;
    if (frame.type === "ack") connection?.ack(frame.seq);
    if (frame.type === "bind") {
      runFork(
        bind({ threadId: frame.threadId, lane: frame.lane }).pipe(
          Effect.match({
            onFailure: (error) =>
              connection?.sendControl({
                type: "bound",
                threadId: frame.threadId,
                lane: lanes.get(frame.threadId)?.lane ?? null,
                error: error.code,
              }),
            onSuccess: (result) => connection?.sendControl({ type: "bound", ...result }),
          }),
        ),
      );
    }
  };

  const layerScope = yield* Effect.scope;
  const reconciling = yield* Semaphore.make(1);
  let linkFiber: Fiber.Fiber<unknown, unknown> | null = null;

  const reconcile = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    const url = current?.hostLinkUrl.trim() ?? "";
    const on = current?.hostLinkEnabled === true && /^wss?:\/\//.test(url);
    const token = on
      ? yield* readHostLinkToken.pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        )
      : null;
    const key = on
      ? `${url}\n${token === null ? "" : NodeCrypto.createHash("sha256").update(token).digest("hex")}`
      : "";
    if (key === connectionKey) return;
    connectionKey = key;
    coalescer.flush();
    connection = null;
    if (linkFiber !== null) yield* Fiber.interrupt(linkFiber);
    linkFiber = null;
    if (!on) return;
    const next = makeHostLinkConnection({
      url,
      token,
      bootId,
      nextSeq,
      hello: () => ({
        type: "hello",
        protocol: HOST_LINK_PROTOCOL,
        environmentId,
        bootId,
        lanes: laneList(),
      }),
      onFrame,
    });
    connection = next;
    linkFiber = yield* Effect.forkIn(next.run, layerScope);
  }).pipe(
    reconciling.withPermits(1),
    Effect.catchCause((cause) => Effect.logWarning("Host link reconcile failed", { cause })),
  );

  const mapEvent = makeHostLinkEventMapper();
  yield* forkParked(
    orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((domainEvent) =>
        Effect.sync(() => {
          if (connection === null || !lanes.has(domainEvent.threadId)) return;
          const event = mapEvent(domainEvent);
          if (event !== null) push(event);
        }),
      ),
      Effect.catchCause((cause) => Effect.logWarning("Host link event feed stopped", { cause })),
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => reconcile));
  yield* forkParked(reconcile.pipe(Effect.repeat(Schedule.spaced(RECONCILE_EVERY))));
  yield* forkParked(
    Effect.sync(() => coalescer.flush()).pipe(Effect.repeat(Schedule.spaced(COALESCE_EVERY))),
  );

  const status = Effect.fn("HostLinkService.status")(function* (input: {
    readonly threadId?: ThreadId;
  }) {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    const snapshot = connection?.snapshot();
    return {
      enabled: current?.hostLinkEnabled === true,
      url: current?.hostLinkUrl ?? "",
      state: snapshot?.state ?? "off",
      connectedAt: snapshot?.connectedAt ?? null,
      lastHeardAt: snapshot?.lastHeardAt ?? null,
      lastError: snapshot?.lastError ?? null,
      reconnects: snapshot?.reconnects ?? 0,
      unacked: snapshot?.unacked ?? 0,
      lanes: [...lanes]
        .filter(([threadId]) => input.threadId === undefined || threadId === input.threadId)
        .map(([threadId, value]) => ({
          threadId: threadId as ThreadId,
          lane: value.lane,
          boundAt: value.boundAt,
        })),
    };
  });

  return HostLinkService.of({ bind, status });
});

export const layer = Layer.effect(HostLinkService, make);
