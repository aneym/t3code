import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request, subscribe } from "@t3tools/client-runtime/rpc";
import {
  AuthPreviewOperateScope,
  DesktopBrowserRemoteEnvelope,
  DesktopBrowserRendererCommand,
  type EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult } from "effect/reactivity";
import { subscribeClientSettings } from "~/hooks/useSettings";
import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentCatalog } from "~/connection/catalog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentSession, readEnvironmentScope } from "~/state/session";

import { remoteDeviceAccess } from "./remoteDeviceAccess";

type Registry = EnvironmentRegistry.EnvironmentRegistry["Service"];
interface Relay {
  readonly control: boolean;
  fiber: Fiber.Fiber<void, unknown> | undefined;
}

const RELAY_RETRY_MS = 5_000;
const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(DesktopBrowserRemoteEnvelope),
);
const encodeCommand = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserRendererCommand));

export function startRemoteBrowserRelays(deviceName: string): () => void {
  const bridge = window.desktopBridge?.desktopBrowser;
  if (!bridge) return () => {};
  let attached: Context.Context<Registry> | null = null;
  let stopRelays: (() => void) | undefined;
  const attach = () => {
    const context = Option.getOrNull(
      AsyncResult.value(appAtomRegistry.get(connectionAtomRuntime)),
    ) as Context.Context<Registry> | null;
    if (context === attached) return;
    stopRelays?.();
    stopRelays = undefined;
    attached = context;
    if (!context) return;
    const registry = Context.get(
      context,
      EnvironmentRegistry.EnvironmentRegistry as never,
    ) as unknown as Registry;
    stopRelays = runRemoteBrowserRelays(bridge, registry, deviceName);
  };
  const unwatch = appAtomRegistry.subscribe(connectionAtomRuntime, attach);
  attach();
  return () => {
    unwatch();
    stopRelays?.();
  };
}

function runRemoteBrowserRelays(
  bridge: NonNullable<NonNullable<typeof window.desktopBridge>["desktopBrowser"]>,
  registry: Registry,
  deviceName: string,
): () => void {
  const relays = new Map<EnvironmentId, Relay>();
  const watched = new Map<EnvironmentId, () => void>();
  const disposers: Array<() => void> = [];
  let retry: ReturnType<typeof setTimeout> | undefined;
  const report = (environmentId: EnvironmentId, events: ReadonlyArray<string>) =>
    void Effect.runPromise(
      registry
        .run(
          environmentId,
          request(WS_METHODS.desktopBrowserEvents, {
            deviceName,
            focused: getDocumentActivity().focused,
            events: [...events],
          }),
        )
        .pipe(Effect.ignore),
    );
  const stop = (environmentId: EnvironmentId) => {
    const relay = relays.get(environmentId);
    if (!relay) return;
    relays.delete(environmentId);
    if (relay.fiber) void Effect.runPromise(Fiber.interrupt(relay.fiber));
  };
  const eligible = (environmentId: EnvironmentId, enabled: boolean) => {
    if (!enabled || environmentId === appAtomRegistry.get(primaryEnvironmentIdAtom)) return false;
    const state = Option.getOrNull(
      AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
    );
    return (
      state?.phase === "connected" && readEnvironmentScope(environmentId, AuthPreviewOperateScope)
    );
  };
  const scheduleRetry = () => {
    retry = setTimeout(refresh, RELAY_RETRY_MS);
  };
  const refresh = () => {
    clearTimeout(retry);
    const access = remoteDeviceAccess();
    const control = access === "control";
    const entries = appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries;
    const wanted = new Set<EnvironmentId>();
    for (const [environmentId, entry] of entries) {
      if (!watched.has(environmentId)) {
        const unwatchState = appAtomRegistry.subscribe(
          environmentCatalog.stateAtom(environmentId),
          refresh,
        );
        const unwatchSession = appAtomRegistry.subscribe(
          environmentSession.sessionStateAtom(environmentId),
          refresh,
        );
        watched.set(environmentId, () => {
          unwatchState();
          unwatchSession();
        });
      }
      if (access !== "off" && eligible(environmentId, entry.enabled)) wanted.add(environmentId);
    }
    for (const [environmentId, relay] of relays) {
      if (!wanted.has(environmentId) || relay.control !== control) stop(environmentId);
    }
    for (const environmentId of wanted) {
      if (relays.has(environmentId)) continue;
      const relay: Relay = { control, fiber: undefined };
      relays.set(environmentId, relay);
      relay.fiber = Effect.runFork(
        registry
          .runStream(
            environmentId,
            subscribe(WS_METHODS.desktopBrowserCommands, {
              deviceName,
              focused: getDocumentActivity().focused,
              control,
            }),
          )
          .pipe(
            Stream.runForEach((line) =>
              Effect.promise(() =>
                control && typeof line === "string"
                  ? bridge.sendCommand(encodeCommand({ type: "remote", environmentId, line }))
                  : Promise.resolve(),
              ),
            ),
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                if (relays.get(environmentId) !== relay) return;
                relays.delete(environmentId);
                scheduleRetry();
              }),
            ),
          ),
      );
    }
  };
  const forwardEvent = (text: string) => {
    const envelope = decodeEnvelope(text);
    if (Option.isNone(envelope)) return;
    const environmentId = envelope.value.environmentId as EnvironmentId;
    if (relays.get(environmentId)?.control) report(environmentId, [envelope.value.line]);
  };
  disposers.push(
    bridge.onEvent(forwardEvent),
    subscribeDocumentActivity(() => {
      for (const environmentId of relays.keys()) report(environmentId, []);
    }),
    subscribeClientSettings(refresh),
    appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, refresh),
  );
  refresh();
  return () => {
    clearTimeout(retry);
    for (const dispose of disposers) dispose();
    for (const unwatch of watched.values()) unwatch();
    for (const environmentId of relays.keys()) stop(environmentId);
  };
}
