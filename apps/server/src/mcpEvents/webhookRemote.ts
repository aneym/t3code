import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  decodeRuntimeConfig,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { relayHookBaseUrl } from "../scheduledTasks/ScheduledTaskService.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { callEventsMethod } from "./eventsRpc.ts";
import type { StoredCredential } from "./eventText.ts";
import * as Store from "./McpEventsStore.ts";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const RemoteGrant = Schema.Struct({
  id: Schema.optional(Schema.String),
  refreshBefore: Schema.optional(Schema.NullOr(Schema.String)),
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  truncated: Schema.optional(Schema.Boolean),
});
const decodeGrant = Schema.decodeUnknownOption(RemoteGrant);

export const webhookCallbackBase = Effect.fn("McpEvents.webhookCallbackBase")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  settings: ServerSettings.ServerSettingsService["Service"],
) {
  const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  const override = current?.mcpEventsCallbackBaseUrl.trim().replace(/\/+$/, "") ?? "";
  if (override !== "") return `${override}/api/hooks`;
  const [relayUrl, tunnelConfig] = yield* Effect.all([
    secrets.get(RELAY_URL_SECRET),
    secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
  ]).pipe(Effect.orElseSucceed(() => [Option.none(), Option.none()] as const));
  if (Option.isSome(relayUrl) && Option.isSome(tunnelConfig)) {
    const config = decodeRuntimeConfig(new TextDecoder().decode(tunnelConfig.value));
    const base = relayHookBaseUrl({
      relayUrl: new TextDecoder().decode(relayUrl.value),
      tunnelName: Option.isSome(config) ? config.value.tunnelName : undefined,
    });
    if (base !== null) return base;
  }
  return yield* new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "No public callback for MCP Events: link T3 Connect, or set mcpEventsCallbackBaseUrl.",
  });
});

export const subscribeRemote = Effect.fn("McpEvents.subscribeRemote")(function* (
  row: Store.SubscriptionRow,
  credential: StoredCredential,
  ttlMs: number | undefined,
) {
  const subscription = Store.toSubscription(row);
  const result = yield* callEventsMethod(subscription.server, "events/subscribe", {
    name: row.name,
    arguments: subscription.arguments,
    delivery: { mode: "webhook", url: credential.url, secret: credential.secret },
    cursor: row.cursor,
    ttlMs: ttlMs ?? DEFAULT_TTL_MS,
  });
  const grant = Option.getOrElse(decodeGrant(result), () => ({}) as typeof RemoteGrant.Type);
  yield* Store.markSubscribed({
    id: row.id,
    remoteId: grant.id ?? null,
    refreshBefore: grant.refreshBefore ?? null,
    subscribedAt: DateTime.formatIso(yield* DateTime.now),
    deliveryUrl: credential.url,
  });
  const cursor = grant.cursor ?? null;
  yield* Store.saveCursor(row.id, cursor, grant.truncated === true && cursor !== null);
});

export const unsubscribeRemote = (row: Store.SubscriptionRow, url: string) => {
  const subscription = Store.toSubscription(row);
  return callEventsMethod(subscription.server, "events/unsubscribe", {
    name: row.name,
    arguments: subscription.arguments,
    delivery: { mode: "webhook", url },
  });
};
