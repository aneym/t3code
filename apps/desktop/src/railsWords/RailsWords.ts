import * as NodeOS from "node:os";

import {
  ConnectBody,
  DEVICE_NAME_MAX_LENGTH,
  RAILS_ORIGIN,
  RailsRoute,
  REQUEST_TIMEOUT_MS,
  SAID_BODY_MAX_BYTES,
  SaidBody,
  encodeBody,
  readRailsAnswer,
  signRailsRequest,
  type RailsAnswer,
} from "@t3tools/client-runtime/rails-words/said-wire";
import type {
  DesktopRailsWordsNotice,
  DesktopRailsWordsSaid,
  DesktopRailsWordsState,
} from "@t3tools/contracts";
import { readRailsConnectLink, type RailsConnectLink } from "@t3tools/shared/railsConnectLink";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { RAILS_WORDS_STATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as RailsDeviceKey from "./RailsDeviceKey.ts";

const QUEUE_LIMIT = 20;
const FRESH_MS = 10 * 60_000;
const AHEAD_MS = 2 * 60_000;
const RETRY_DELAYS_MS = [2_000, 10_000, 60_000];
const SESSION_PARTITION = "t3-rails-words";

interface QueuedSaid {
  readonly body: SaidBody;
  readonly typedAtMs: number;
  attempts: number;
  notBefore: number;
  clockRetried: boolean;
}

interface Connected {
  readonly device: RailsDeviceKey.StoredDevice;
  readonly key: ReturnType<typeof RailsDeviceKey.proofKey>;
}

const decodeSaidBody = Schema.decodeUnknownOption(SaidBody);
const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export class RailsWords extends Context.Service<
  RailsWords,
  {
    readonly getState: Effect.Effect<DesktopRailsWordsState>;
    readonly said: (input: DesktopRailsWordsSaid) => Effect.Effect<void>;
    readonly disconnect: Effect.Effect<DesktopRailsWordsState>;
    readonly receiveLink: (value: string) => boolean;
  }
>()("@t3tools/desktop/railsWords/RailsWords") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const deviceKey = yield* RailsDeviceKey.RailsDeviceKey;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const scope = yield* Effect.scope;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const context = yield* Effect.context<never>();
  const devOrigin = environment.isDevelopment
    ? yield* DesktopConfig.trimmedString("T3CODE_DEV_RAILS_ORIGIN").pipe(
        Effect.orElseSucceed(Option.none),
      )
    : Option.none<string>();
  const origin = Option.getOrElse(devOrigin, () => RAILS_ORIGIN);

  const queue: Array<QueuedSaid> = [];
  let connected: Connected | null | undefined;
  let clockOffsetSeconds = 0;
  let pumping = false;
  let state: DesktopRailsWordsState = {
    connected: false,
    deviceName: null,
    connectedAt: null,
    lastSentAt: null,
    unreachableSince: null,
    notice: null,
  };

  const publish = (patch: Partial<DesktopRailsWordsState>) =>
    Effect.suspend(() => {
      state = { ...state, ...patch };
      return electronWindow.sendAll(RAILS_WORDS_STATE_CHANNEL, state);
    });

  const enabled = clientSettings.get.pipe(
    Effect.map((settings) => Option.isSome(settings) && settings.value.railsWordsEnabled),
    Effect.orElseSucceed(() => false),
  );

  const ensureLoaded = Effect.gen(function* () {
    if (connected !== undefined) return connected;
    const stored = yield* deviceKey.load.pipe(
      Effect.tapError((error) => Effect.logWarning("Could not read the Rails device key.", error)),
      Effect.orElseSucceed(() => Option.none<RailsDeviceKey.StoredDevice>()),
    );
    connected = Option.match(stored, {
      onNone: () => null,
      onSome: (device) => ({ device, key: RailsDeviceKey.proofKey(device) }),
    });
    state = {
      ...state,
      connected: connected !== null,
      deviceName: connected?.device.deviceName ?? null,
      connectedAt: connected?.device.connectedAt ?? null,
    };
    return connected;
  });

  const forget = Effect.fn("RailsWords.forget")(function* (notice: DesktopRailsWordsNotice) {
    queue.length = 0;
    connected = null;
    yield* deviceKey.remove.pipe(
      Effect.catch((error) => Effect.logWarning("Could not delete the Rails device key.", error)),
    );
    yield* publish({
      connected: false,
      deviceName: null,
      connectedAt: null,
      unreachableSince: null,
      notice,
    });
  });

  let railsSession: Electron.Session | null = null;
  const send = Effect.fn("RailsWords.send")(function* (
    route: RailsRoute,
    body: SaidBody | ConnectBody | undefined,
    key: Connected["key"],
  ) {
    const request = yield* signRailsRequest({
      origin,
      route,
      body,
      key,
      clockOffsetSeconds,
      nowMillis: yield* Clock.currentTimeMillis,
    }).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(SecureRandom.SecureRandom, random),
    );
    railsSession ??= Electron.session.fromPartition(SESSION_PARTITION, { cache: false });
    const fetcher = railsSession;
    return yield* Effect.tryPromise({
      try: async (): Promise<RailsAnswer> => {
        const response = await fetcher.fetch(request.url, {
          method: request.method,
          headers: request.headers,
          credentials: "omit",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ...(request.method === "GET" ? {} : { body: Buffer.from(request.body) }),
        });
        const answer: unknown = await response.json().catch(() => null);
        return readRailsAnswer(response.status, answer);
      },
      catch: () => "unreachable" as const,
    }).pipe(Effect.orElseSucceed((): RailsAnswer => ({ kind: "retry" })));
  });

  const sendWithClock = Effect.fn("RailsWords.sendWithClock")(function* (
    route: RailsRoute,
    body: SaidBody | ConnectBody,
    key: Connected["key"],
  ) {
    const answer = yield* send(route, body, key);
    if (answer.kind !== "clock") return answer;
    clockOffsetSeconds = answer.railsEpoch - Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    return yield* send(route, body, key);
  });

  const pumpOnce = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index]!.typedAtMs < now - FRESH_MS) queue.splice(index, 1);
    }
    const item = queue[0];
    const current = connected;
    if (item === undefined || !current) return false;
    if (item.notBefore > now) {
      yield* Effect.sleep(Duration.millis(item.notBefore - now));
      return true;
    }
    if (!(yield* enabled)) {
      queue.length = 0;
      return false;
    }
    const answer = yield* send(RailsRoute.said, item.body, current.key);
    switch (answer.kind) {
      case "ok":
        queue.shift();
        yield* publish({ lastSentAt: isoAt(now), unreachableSince: null });
        return true;
      case "retry": {
        const delay = RETRY_DELAYS_MS[item.attempts];
        item.attempts += 1;
        if (delay === undefined) queue.shift();
        else item.notBefore = now + delay;
        if (state.unreachableSince === null) {
          yield* publish({ unreachableSince: isoAt(now) });
        }
        return true;
      }
      case "clock":
        clockOffsetSeconds = answer.railsEpoch - Math.floor(now / 1_000);
        if (item.clockRetried) queue.shift();
        item.clockRetried = true;
        return true;
      case "removed":
        yield* forget("removed-in-rails");
        return false;
      case "refused":
        yield* Effect.logWarning("Rails refused a typed turn.", { error: answer.error });
        queue.shift();
        return true;
    }
  });

  const kick: Effect.Effect<void> = Effect.suspend(() => {
    if (pumping) return Effect.void;
    pumping = true;
    const loop = Effect.gen(function* () {
      let more = true;
      while (more) more = yield* pumpOnce;
    });
    return loop.pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          pumping = false;
          return queue.length > 0 && connected ? kick : Effect.void;
        }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });

  const said = Effect.fn("RailsWords.said")(
    function* (input: DesktopRailsWordsSaid) {
      if (!(yield* enabled) || !(yield* ensureLoaded)) return;
      const typedAtMs = Date.parse(input.typedAt);
      const now = yield* Clock.currentTimeMillis;
      if (!Number.isFinite(typedAtMs) || typedAtMs < now - FRESH_MS || typedAtMs > now + AHEAD_MS) {
        return;
      }
      const body = decodeSaidBody({
        environment: input.environmentId,
        thread: input.threadId,
        agent: input.agent,
        message_id: input.messageId,
        text: input.text,
        typed_at: isoAt(typedAtMs),
      });
      if (Option.isNone(body) || encodeBody(body.value).byteLength > SAID_BODY_MAX_BYTES) return;
      if (queue.some((item) => item.body.message_id === body.value.message_id)) return;
      if (queue.length >= QUEUE_LIMIT) queue.shift();
      queue.push({ body: body.value, typedAtMs, attempts: 0, notBefore: 0, clockRetried: false });
      yield* kick;
    },
    Effect.catchCause((cause) => Effect.logWarning("Rails words dropped a turn.", cause)),
  );

  const confirmConnect = Effect.fn("RailsWords.confirmConnect")(function* (
    replacing: string | null,
  ) {
    const owner = Option.getOrUndefined(yield* electronWindow.currentMainOrFirst);
    const result = yield* dialog.showMessageBox(
      {
        type: "question",
        message: "Connect T3 Code on this computer to Rails?",
        detail: [
          "Continue only if you just clicked Connect in Rails settings.",
          replacing === null ? null : `This replaces the connection "${replacing}".`,
        ]
          .filter((line) => line !== null)
          .join("\n\n"),
        buttons: [replacing === null ? "Connect" : "Replace", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      },
      owner,
    );
    return result.response === 0;
  });

  const tell = Effect.fn("RailsWords.tell")(function* (message: string, detail: string) {
    const owner = Option.getOrUndefined(yield* electronWindow.currentMainOrFirst);
    yield* dialog.showMessageBox({ type: "info", message, detail }, owner).pipe(Effect.ignore);
  });

  const connect = Effect.fn("RailsWords.connect")(function* (link: RailsConnectLink) {
    if (link.origin !== null && link.origin !== origin) {
      yield* Effect.logWarning("Ignored a Rails connect link for another origin.");
      return;
    }
    if (!(yield* enabled)) {
      yield* tell(
        "Turn on Rails words first.",
        "Open Settings, Connections, This app, turn on Send typed words to Rails, then click Connect in Rails again.",
      );
      return;
    }
    if (!(yield* deviceKey.storageUsable)) {
      yield* publish({ notice: "storage-unavailable" });
      yield* tell(
        "T3 Code can't connect to Rails here.",
        "This computer has no secure key storage, so the device key can't be kept safely.",
      );
      return;
    }
    const existing = yield* ensureLoaded;
    if (!(yield* confirmConnect(existing?.device.deviceName ?? null))) return;
    const pair = RailsDeviceKey.generateKeyPair();
    const key = RailsDeviceKey.proofKey(pair);
    const name = `T3 Code on ${NodeOS.hostname()}`.slice(0, DEVICE_NAME_MAX_LENGTH);
    const answer = yield* sendWithClock(RailsRoute.connect, { ticket: link.ticket, name }, key);
    if (answer.kind !== "ok" || answer.device === null) {
      yield* publish({ notice: answer.kind === "retry" ? "connect-failed" : "connect-refused" });
      return;
    }
    const device: RailsDeviceKey.StoredDevice = {
      ...pair,
      deviceId: answer.device.id,
      deviceName: answer.device.name,
      connectedAt: answer.device.created_at,
    };
    const stored = yield* deviceKey.store(device).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not store the Rails device key.", error).pipe(Effect.as(false)),
      ),
    );
    if (!stored) {
      yield* publish({ notice: "storage-unavailable" });
      return;
    }
    queue.length = 0;
    connected = { device, key };
    yield* publish({
      connected: true,
      deviceName: device.deviceName,
      connectedAt: device.connectedAt,
      lastSentAt: null,
      unreachableSince: null,
      notice: null,
    });
  });

  const runFork = Effect.runForkWith(context);

  return RailsWords.of({
    getState: ensureLoaded.pipe(Effect.map(() => state)),
    said,
    disconnect: Effect.gen(function* () {
      yield* ensureLoaded;
      yield* forget("disconnected-here");
      return state;
    }).pipe(Effect.withSpan("RailsWords.disconnect")),
    receiveLink: (value) => {
      const link = readRailsConnectLink(value);
      if (link === null) return false;
      runFork(
        connect(link).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Rails connect failed.", cause)),
          Effect.forkIn(scope),
        ),
      );
      return true;
    },
  });
});

export const layer = Layer.effect(RailsWords, make).pipe(Layer.provide(RailsDeviceKey.layer));
