// @effect-diagnostics-next-line nodeBuiltinImport:off -- Ids and message keys need random bytes and a digest.
import * as NodeCrypto from "node:crypto";

import {
  McpEventsServer,
  type McpEventsListInput,
  type McpEventsListResult,
  type McpEventsSubscribeInput,
  type McpEventsSubscription,
  type McpEventsUnsubscribeResult,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/http/HttpClient";
import type * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeDelivery } from "./eventDelivery.ts";
import { callEventsMethod, serverKey } from "./eventsRpc.ts";
import { subscribeRemote, unsubscribeRemote, webhookCallbackBase } from "./webhookRemote.ts";
import * as Store from "./McpEventsStore.ts";
import { deliveryModes, runPull } from "./pullDelivery.ts";
import { handleWebhookBody, type McpEventsReceipt } from "./webhookBody.ts";
import {
  newUrlToken,
  newWebhookSecret,
  tokenHash,
  tokenMatches,
  verifyWebhook,
} from "./webhookSignature.ts";
import { rpcMessage, type StoredCredential } from "./eventText.ts";

export const HOOK_ID_PREFIX = "mcpev_";
const MAX_BODY_BYTES = 256 * 1024;
const RATE_LIMIT_PER_MINUTE = 120;
const MIN_REFRESH_LEAD_MS = 120_000;

const Credential = Schema.fromJsonString(
  Schema.Struct({ secret: Schema.String, url: Schema.String }),
);
const decodeCredential = Schema.decodeUnknownOption(Credential);
const ServerJson = Schema.fromJsonString(McpEventsServer);
const encodeCredential = Schema.encodeEffect(Credential);
const encodeServerJson = Schema.encodeEffect(ServerJson);
const secretName = (id: string) => `mcp-events-${id}`;
const failure = (
  code: "invalid_request" | "orchestration_error" | "thread_not_found",
  message: string,
) => new OrchestratorMcpFailure({ code, message });
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const asFailure = (message: string) => (error: unknown) =>
  isMcpFailure(error) ? error : failure("orchestration_error", message);
const reply = (status: number, body: Record<string, unknown>): McpEventsReceipt => ({
  status,
  body,
});

export class McpEventsService extends Context.Service<
  McpEventsService,
  {
    readonly subscribe: (
      input: McpEventsSubscribeInput & { readonly threadId: ThreadId },
    ) => Effect.Effect<McpEventsSubscription, OrchestratorMcpFailure>;
    readonly list: (
      input: McpEventsListInput,
    ) => Effect.Effect<McpEventsListResult, OrchestratorMcpFailure>;
    readonly unsubscribe: (
      subscriptionId: string,
    ) => Effect.Effect<McpEventsUnsubscribeResult, OrchestratorMcpFailure>;
    readonly moveThreadSubscriptions: (
      from: string,
      to: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly removeThreadSubscriptions: (
      threadId: string,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly receive: (input: {
      readonly hookId: string;
      readonly token: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
      readonly relayReceivedAt?: string;
    }) => Effect.Effect<McpEventsReceipt>;
  }
>()("t3/mcpEvents/McpEventsService") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const context = yield* Effect.context<SqlClient.SqlClient | HttpClient.HttpClient>();
  const rateWindows = new Map<string, { start: number; count: number }>();
  const pulls = yield* FiberMap.make<string>();
  const deliverOnce = makeDelivery(threads);

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.mcpEventsEnabled),
    Effect.orElseSucceed(() => false),
  );
  const requireEnabled = Effect.flatMap(enabled, (on) =>
    on
      ? Effect.void
      : Effect.fail(
          failure(
            "invalid_request",
            "MCP Events is off. Turn on Settings → Chat → Follow-ups → MCP Events subscriptions.",
          ),
        ),
  );

  const callbackBase = webhookCallbackBase(secrets, settings);
  const lifecycle = yield* Semaphore.make(1);
  const readCredential = (id: string) =>
    secrets
      .get(secretName(id))
      .pipe(
        Effect.map((value) =>
          Option.flatMap(value, (bytes) => decodeCredential(new TextDecoder().decode(bytes))),
        ),
      );

  const dropReplaced = Effect.fn("McpEventsService.dropReplaced")(function* (
    row: Store.SubscriptionRow,
    base: string,
  ) {
    const url = row.delivery_url;
    if (url !== null && url.startsWith(`${base}/${row.id}/`)) {
      yield* unsubscribeRemote(row, url).pipe(
        Effect.catch((error) =>
          Effect.logWarning("MCP Events could not unsubscribe a replaced subscription", {
            subscriptionId: row.id,
            error: rpcMessage(error, { url, secret: "" }),
          }),
        ),
      );
    }
    yield* Store.remove(row.id);
  });

  const startPull = (id: string) =>
    FiberMap.run(
      pulls,
      id,
      runPull(id, enabled, deliverOnce).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("MCP Events pull stopped", { subscriptionId: id, cause }),
        ),
        Effect.provide(context),
      ),
      { onlyIfMissing: true },
    );

  const removeRow = Effect.fn("McpEventsService.removeRow")(function* (row: Store.SubscriptionRow) {
    yield* FiberMap.remove(pulls, row.id);
    const credential = yield* readCredential(row.id).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    const url = Option.match(credential, {
      onNone: () => row.delivery_url,
      onSome: (value) => value.url,
    });
    const hidden = {
      url: url ?? "",
      secret: Option.isSome(credential) ? credential.value.secret : "",
    };
    const remote =
      row.delivery_mode !== "webhook"
        ? "stopped"
        : url === null
          ? "skipped"
          : yield* unsubscribeRemote(row, url).pipe(
              Effect.as("ok"),
              Effect.catch((error) => Effect.succeed(`failed: ${rpcMessage(error, hidden)}`)),
            );
    yield* Store.remove(row.id);
    yield* secrets.remove(secretName(row.id)).pipe(Effect.ignore);
    return remote;
  });

  const pickMode = Effect.fn("McpEventsService.pickMode")(function* (
    server: McpEventsServer,
    name: string,
  ) {
    const modes = yield* deliveryModes(server, name).pipe(
      Effect.mapError((error) => failure("orchestration_error", rpcMessage(error))),
    );
    const mode = (["webhook", "push", "poll"] as const).find((each) => modes.includes(each));
    if (mode === undefined) {
      return yield* failure("invalid_request", `${name} offers no delivery mode T3 supports.`);
    }
    return mode;
  });

  const subscribe = Effect.fn("McpEventsService.subscribe")(
    function* (input: Parameters<McpEventsService["Service"]["subscribe"]>[0]) {
      yield* requireEnabled;
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null)
        return yield* failure("thread_not_found", `Thread ${input.threadId} not found.`);
      const argumentsJson = Store.canonicalJson(input.arguments ?? {});
      const key = {
        threadId: input.threadId,
        serverKey: serverKey(input.server),
        name: input.name,
        argumentsJson,
      };
      const serverJson = yield* encodeServerJson(input.server);
      const existing = yield* Store.findByKey(key);
      if (existing !== undefined && existing.server_json !== serverJson) {
        yield* Store.updateServer(existing.id, serverJson);
      }
      if (existing?.status === "terminated") yield* Store.markStatus(existing.id, "pending", null);
      if (existing !== undefined && existing.delivery_mode !== "webhook") {
        yield* startPull(existing.id);
        const current = yield* Store.findById(existing.id);
        if (current === undefined)
          return yield* failure("orchestration_error", "Subscription vanished.");
        return Store.toSubscription(current);
      }
      const mode = existing === undefined ? yield* pickMode(input.server, input.name) : "webhook";
      if (mode !== "webhook") {
        const id = `${HOOK_ID_PREFIX}${NodeCrypto.randomBytes(10).toString("hex")}`;
        yield* Store.insertPending({
          id,
          ...key,
          serverJson,
          tokenHash: tokenHash(newUrlToken()),
          createdAt: DateTime.formatIso(yield* DateTime.now),
          deliveryMode: mode,
          deliveryUrl: null,
        });
        yield* startPull(id);
        const pending = yield* Store.findById(id);
        if (pending === undefined)
          return yield* failure("orchestration_error", "Could not store the subscription.");
        return Store.toSubscription(pending);
      }
      let row = existing === undefined ? undefined : yield* Store.findById(existing.id);
      let credential =
        existing === undefined
          ? Option.none<StoredCredential>()
          : yield* readCredential(existing.id);
      if (row === undefined || Option.isNone(credential)) {
        const base = yield* callbackBase;
        if (row !== undefined) yield* dropReplaced(row, base);
        const id = `${HOOK_ID_PREFIX}${NodeCrypto.randomBytes(10).toString("hex")}`;
        const token = newUrlToken();
        const fresh = { secret: newWebhookSecret(), url: `${base}/${id}/${token}` };
        const encoded = yield* encodeCredential(fresh);
        yield* secrets.set(secretName(id), new TextEncoder().encode(encoded));
        yield* Store.insertPending({
          id,
          ...key,
          serverJson,
          tokenHash: tokenHash(token),
          createdAt: DateTime.formatIso(yield* DateTime.now),
          deliveryMode: "webhook",
          deliveryUrl: null,
        });
        row = yield* Store.findById(id);
        credential = Option.some(fresh);
      }
      if (row === undefined || Option.isNone(credential)) {
        return yield* failure("orchestration_error", "Could not store the subscription.");
      }
      const created = existing === undefined || existing.id !== row.id;
      const subscribed = yield* subscribeRemote(row, credential.value, input.ttlMs).pipe(
        Effect.result,
      );
      if (subscribed._tag === "Failure") {
        if (created) {
          yield* Store.remove(row.id);
          yield* secrets.remove(secretName(row.id)).pipe(Effect.ignore);
        } else {
          yield* Store.markStatus(
            row.id,
            "failing",
            rpcMessage(subscribed.failure, credential.value),
          );
        }
        return yield* failure(
          "orchestration_error",
          rpcMessage(subscribed.failure, credential.value),
        );
      }
      const saved = yield* Store.findById(row.id);
      if (saved === undefined)
        return yield* failure("orchestration_error", "Subscription vanished.");
      return Store.toSubscription(saved);
    },
    Effect.mapError(asFailure("Could not persist the subscription.")),
    lifecycle.withPermits(1),
    Effect.provide(context),
  );

  const list = Effect.fn("McpEventsService.list")(
    function* (input: McpEventsListInput) {
      const rows = yield* Store.list(input.threadId);
      const subscriptions = rows.map(Store.toSubscription);
      if (input.server === undefined) return { subscriptions };
      yield* requireEnabled;
      const catalog = yield* callEventsMethod(input.server, "events/list", {}).pipe(
        Effect.mapError((error) => failure("orchestration_error", rpcMessage(error))),
      );
      return { subscriptions, catalog };
    },
    Effect.mapError(asFailure("Could not read subscriptions.")),
    Effect.provide(context),
  );

  const unsubscribe = Effect.fn("McpEventsService.unsubscribe")(
    function* (subscriptionId: string) {
      const row = yield* Store.findById(subscriptionId);
      if (row === undefined) return { subscriptionId, removed: false, remote: "not_found" };
      const remote = yield* removeRow(row);
      return { subscriptionId, removed: true, remote };
    },
    Effect.mapError(asFailure("Could not remove the subscription.")),
    lifecycle.withPermits(1),
    Effect.provide(context),
  );

  const removeThreadSubscriptions = Effect.fn("McpEventsService.removeThreadSubscriptions")(
    function* (threadId: string) {
      for (const row of yield* Store.list(threadId)) yield* removeRow(row);
    },
    Effect.mapError(asFailure("Could not remove the thread's subscriptions.")),
    lifecycle.withPermits(1),
    Effect.provide(context),
  );

  const moveThreadSubscriptions = Effect.fn("McpEventsService.moveThreadSubscriptions")(
    function* (from: string, to: string) {
      if (from === to) return;
      yield* Store.moveThread(from, to);
      for (const row of yield* Store.list(from)) yield* removeRow(row);
    },
    Effect.mapError(asFailure("Could not move the thread's subscriptions.")),
    lifecycle.withPermits(1),
    Effect.provide(context),
  );

  const allowRate = (id: string, now: number) => {
    const window = rateWindows.get(id);
    if (window === undefined || now - window.start >= 60_000) {
      rateWindows.set(id, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= RATE_LIMIT_PER_MINUTE;
  };

  const receive = Effect.fn("McpEventsService.receive")(
    function* (input: Parameters<McpEventsService["Service"]["receive"]>[0]) {
      if (!(yield* enabled)) return reply(503, { error: "mcp_events_disabled" });
      if (input.body.byteLength > MAX_BODY_BYTES) return reply(413, { error: "body_too_large" });
      const row = yield* Store.findById(input.hookId);
      if (row === undefined) return reply(410, { error: "subscription_gone" });
      if (!tokenMatches(input.token, row.token_hash))
        return reply(404, { error: "hook_not_found" });
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (!allowRate(row.id, nowMs)) return reply(429, { error: "rate_limited" });
      const stored = yield* readCredential(row.id).pipe(Effect.result);
      if (stored._tag === "Failure") return reply(503, { error: "credential_unavailable" });
      const credential = stored.success;
      if (Option.isNone(credential)) return reply(410, { error: "subscription_gone" });
      const relayMs =
        input.relayReceivedAt === undefined ? Number.NaN : Date.parse(input.relayReceivedAt);
      const check = verifyWebhook({
        secret: credential.value.secret,
        headers: input.headers,
        body: input.body,
        referenceSeconds: Math.floor((Number.isFinite(relayMs) ? relayMs : nowMs) / 1000),
      });
      if (check !== "valid") {
        yield* Effect.logWarning("MCP event delivery rejected", {
          subscriptionId: row.id,
          reason: check,
        });
        return reply(401, { error: check === "stale" ? "stale_timestamp" : "invalid_signature" });
      }
      return yield* handleWebhookBody({
        row,
        text: new TextDecoder().decode(input.body),
        webhookId: input.headers["webhook-id"],
        deliver: deliverOnce,
      });
    },
    (effect) =>
      Effect.catchCause(effect, (cause) =>
        Effect.logWarning("MCP event delivery failed", { cause }).pipe(
          Effect.as(reply(500, { error: "internal_error" })),
        ),
      ),
    Effect.provide(context),
  );

  const refreshDue = Effect.gen(function* () {
    if (!(yield* enabled)) return;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const row of yield* Store.list(undefined)) {
      const shell = yield* threads
        .getThreadShell(row.thread_id as ThreadId)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (
        shell === null ||
        (shell !== undefined && (shell.deletedAt !== null || shell.archivedAt !== null))
      ) {
        yield* removeRow(row).pipe(
          lifecycle.withPermits(1),
          Effect.catchCause((cause) => Effect.logWarning("MCP Events cleanup failed", { cause })),
        );
        continue;
      }
      if (row.status === "terminated") continue;
      if (row.delivery_mode !== "webhook") {
        yield* startPull(row.id);
        continue;
      }
      const before = row.refresh_before === null ? Number.NaN : Date.parse(row.refresh_before);
      const since = row.subscribed_at === null ? Number.NaN : Date.parse(row.subscribed_at);
      const lead = Math.max(
        MIN_REFRESH_LEAD_MS,
        Number.isFinite(since) ? (before - since) * 0.2 : 0,
      );
      const due =
        row.status === "pending" ||
        row.status === "failing" ||
        (Number.isFinite(before) && now >= before - lead);
      if (!due) continue;
      yield* Effect.gen(function* () {
        const current = yield* Store.findById(row.id);
        if (current === undefined || current.status === "terminated") return;
        const credential = yield* readCredential(row.id);
        if (Option.isNone(credential)) {
          if (current.status !== "failing")
            yield* Store.markStatus(
              row.id,
              "failing",
              "Webhook secret is missing; subscribe again.",
            );
          return;
        }
        yield* subscribeRemote(current, credential.value, undefined).pipe(
          Effect.catch((error) =>
            Store.markStatus(row.id, "failing", rpcMessage(error, credential.value)),
          ),
        );
      }).pipe(
        lifecycle.withPermits(1),
        Effect.catchCause((cause) => Effect.logWarning("MCP Events refresh failed", { cause })),
      );
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("MCP Events refresh failed", { cause })));

  yield* refreshDue.pipe(
    Effect.repeat(Schedule.spaced("60 seconds")),
    Effect.provide(context),
    Effect.forkScoped,
  );

  yield* Stream.runForEach(threads.streamDomainEvents, (event) =>
    event.type === "thread.archived" || event.type === "thread.deleted"
      ? removeThreadSubscriptions(event.threadId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("MCP Events thread cleanup failed", { message: error.message }),
          ),
        )
      : Effect.void,
  ).pipe(
    Effect.catchCause((cause) => Effect.logWarning("MCP Events thread watch stopped", { cause })),
    Effect.forkScoped,
  );

  return McpEventsService.of({
    subscribe,
    list,
    unsubscribe,
    receive,
    moveThreadSubscriptions,
    removeThreadSubscriptions,
  });
});

export const layer = Layer.effect(McpEventsService, make);
