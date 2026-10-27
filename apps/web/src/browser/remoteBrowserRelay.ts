import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request, subscribe } from "@t3tools/client-runtime/rpc";
import { WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { getClientSettings, subscribeClientSettings } from "~/hooks/useSettings";
import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentCatalog } from "~/connection/catalog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

type Registry = EnvironmentRegistry.EnvironmentRegistry["Service"];
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCommand = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.optional(Schema.String),
      tabId: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
    }),
  ),
);
export function startRemoteBrowserRelays(deviceName: string): () => void {
  const bridge = window.desktopBridge?.desktopBrowser;
  if (!bridge) return () => {};
  const context = Option.getOrNull(
    AsyncResult.value(appAtomRegistry.get(connectionAtomRuntime)),
  ) as Context.Context<Registry> | null;
  if (!context) return () => {};
  const registry = Context.get(
    context,
    EnvironmentRegistry.EnvironmentRegistry as never,
  ) as unknown as Registry;
  const fibers = new Map<string, Fiber.Fiber<void, unknown>>();
  const claims = new Map<string, string>();
  const disposers: Array<() => void> = [];
  const send = (environmentId: string) => {
    void Effect.runPromise(
      registry
        .run(
          environmentId as never,
          Effect.promise(() =>
            bridge.sendCommand(
              encodeJson({ deviceName, focused: getDocumentActivity().focused, events: [] }),
            ),
          ),
        )
        .pipe(Effect.ignore),
    );
  };
  const refresh = () => {
    if (!getClientSettings().browserAllowRemoteDeviceTabs) return;
    const primary = appAtomRegistry.get(primaryEnvironmentIdAtom);
    for (const [environmentId, entry] of appAtomRegistry.get(environmentCatalog.catalogValueAtom)
      .entries) {
      if (environmentId === primary || !entry.enabled || fibers.has(environmentId)) continue;
      const state = Option.getOrNull(
        AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
      );
      if (state?.phase !== "connected") continue;
      const stream = registry.runStream(
        environmentId,
        subscribe(WS_METHODS.desktopBrowserCommands, {
          deviceName,
          focused: getDocumentActivity().focused,
        }),
      );
      fibers.set(
        environmentId,
        Effect.runFork(
          stream.pipe(
            Stream.runForEach((line) =>
              Effect.promise(() => {
                if (typeof line !== "string") return Promise.resolve();
                const command = decodeCommand(line);
                if (Option.isSome(command) && command.value.threadId && command.value.tabId) {
                  const key = `${command.value.threadId}\u0000${command.value.tabId}`;
                  if (command.value.type === "release") claims.delete(key);
                  else claims.set(key, environmentId);
                }
                return bridge.sendCommand(line);
              }),
            ),
            Effect.ignore,
          ),
        ),
      );
      send(environmentId);
    }
  };
  const forwardEvent = (line: string) => {
    try {
      const event = JSON.parse(line) as { threadId?: string; tabId?: string };
      if (!event.threadId || !event.tabId) return;
      const environmentId = claims.get(`${event.threadId}\u0000${event.tabId}`);
      if (environmentId)
        void Effect.runPromise(
          registry
            .run(
              environmentId as never,
              request(WS_METHODS.desktopBrowserEvents, { deviceName, events: [line] }),
            )
            .pipe(Effect.ignore),
        );
    } catch {}
  };
  disposers.push(bridge.onEvent(forwardEvent));
  const focus = () => {
    for (const environmentId of fibers.keys()) send(environmentId);
  };
  disposers.push(
    subscribeDocumentActivity(focus),
    subscribeClientSettings(refresh),
    appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, refresh),
  );
  void refresh();
  return () => {
    for (const dispose of disposers) dispose();
    for (const fiber of fibers.values()) void Effect.runPromise(Fiber.interrupt(fiber));
  };
}
