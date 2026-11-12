import type { HostLinkConnectionState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";

const HEARTBEAT_INTERVAL_MS = 20_000;
const SILENCE_LIMIT_MS = 45_000;
const HEARTBEAT_TIMEOUT_CODE = 4000;
const CHECK_EVERY = "2 seconds";
const STABLE_AFTER_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_UNACKED = 1_000;

export interface HostLinkConnectionOptions {
  readonly url: string;
  readonly token: string | null;
  readonly bootId: string;
  readonly nextSeq: () => number;
  readonly hello: () => Record<string, unknown>;
  readonly onFrame: (frame: unknown) => void;
}

export interface HostLinkConnectionSnapshot {
  readonly state: HostLinkConnectionState;
  readonly connectedAt: string | null;
  readonly lastHeardAt: string | null;
  readonly lastError: string | null;
  readonly reconnects: number;
  readonly unacked: number;
}

class LinkDropped {
  readonly _tag = "LinkDropped";
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

const FrameJson = Schema.fromJsonString(Schema.Unknown);
const encodeFrame = Schema.encodeSync(FrameJson);
const decodeFrame = Schema.decodeUnknownOption(FrameJson);

const iso = (ms: number | null) =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));

const describe = (cause: Cause.Cause<unknown>): string => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (error instanceof LinkDropped) return error.reason;
  if (Socket.isSocketError(error)) {
    const reason = error.reason;
    if (reason._tag === "SocketCloseError")
      return `closed ${reason.code}${reason.closeReason ? ` ${reason.closeReason}` : ""}`;
    return reason._tag === "SocketOpenError" ? "could not open" : reason._tag;
  }
  return "socket error";
};

export const makeHostLinkConnection = (options: HostLinkConnectionOptions) => {
  let state: HostLinkConnectionState = "connecting";
  let attempt = 0;
  let reconnects = 0;
  let connectedAt: number | null = null;
  let lastHeardAt: number | null = null;
  let lastPingAt = 0;
  let lastError: string | null = null;
  let unacked: Array<{ readonly seq: number; readonly text: string }> = [];
  let outbox: Queue.Queue<string> | null = null;

  const offer = (text: string) => {
    if (state === "open" && outbox !== null) Queue.offerUnsafe(outbox, text);
  };

  const sendEvent = (frame: Record<string, unknown>) => {
    const seq = options.nextSeq();
    const text = encodeFrame({ type: "event", seq, bootId: options.bootId, ...frame });
    unacked.push({ seq, text });
    if (unacked.length > MAX_UNACKED) unacked.splice(0, unacked.length - MAX_UNACKED);
    offer(text);
  };

  const sendControl = (frame: Record<string, unknown>) => offer(encodeFrame(frame));

  const ack = (upTo: number) => {
    const keep = unacked.findIndex((entry) => entry.seq > upTo);
    unacked = keep === -1 ? [] : unacked.slice(keep);
  };

  const snapshot = (): HostLinkConnectionSnapshot => ({
    state,
    connectedAt: iso(connectedAt),
    lastHeardAt: iso(lastHeardAt),
    lastError,
    reconnects,
    unacked: unacked.length,
  });

  const session = Effect.scoped(
    Effect.gen(function* () {
      state = "connecting";
      const headers: Record<string, string> = {};
      if (options.token !== null) headers.authorization = `Bearer ${options.token}`;
      const socket = yield* Socket.makeWebSocket(options.url, {
        openTimeout: "15 seconds",
        headers,
      }).pipe(Effect.provide(upstreamWebSocketConstructor));
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const queue = yield* Queue.unbounded<string>();
      const now = yield* Clock.currentTimeMillis;
      state = "open";
      connectedAt = now;
      lastHeardAt = now;
      lastPingAt = now;
      lastError = null;
      outbox = queue;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (outbox === queue) outbox = null;
        }),
      );
      yield* writer.write(encodeFrame(options.hello()));
      for (const entry of unacked) yield* writer.write(entry.text);
      yield* Effect.logInfo("Host link open", { url: options.url, resent: unacked.length });

      const reading = Effect.gen(function* () {
        while (true) {
          const batch = yield* reader.pull;
          lastHeardAt = yield* Clock.currentTimeMillis;
          for (const chunk of batch) {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            const decoded = decodeFrame(text);
            if (Option.isNone(decoded)) continue;
            const frame = decoded.value;
            if ((frame as { readonly type?: unknown } | null)?.type === "ping") {
              const at = iso(lastHeardAt);
              yield* writer.write(encodeFrame({ type: "pong", at }));
            } else options.onFrame(frame);
          }
        }
      });
      const writing = Effect.gen(function* () {
        while (true) yield* writer.write(yield* Queue.take(queue));
      });
      const heartbeat = Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        if (connectedAt !== null && current - connectedAt >= STABLE_AFTER_MS) attempt = 0;
        if (lastHeardAt !== null && current - lastHeardAt >= SILENCE_LIMIT_MS) {
          yield* writer
            .write(new Socket.CloseEvent(HEARTBEAT_TIMEOUT_CODE, "heartbeat timeout"))
            .pipe(Effect.ignore);
          return yield* Effect.fail(new LinkDropped("heartbeat timeout"));
        }
        if (current - lastPingAt >= HEARTBEAT_INTERVAL_MS) {
          lastPingAt = current;
          yield* writer.write(encodeFrame({ type: "ping", at: iso(current) }));
        }
      }).pipe(Effect.repeat(Schedule.spaced(CHECK_EVERY)));
      return yield* Effect.raceFirst(reading, Effect.raceFirst(writing, heartbeat));
    }),
  );

  const run = Effect.gen(function* () {
    while (true) {
      const exit = yield* Effect.exit(session);
      lastError = exit._tag === "Failure" ? describe(exit.cause) : "closed";
      state = "backoff";
      connectedAt = null;
      yield* Effect.logInfo("Host link closed", { reason: lastError });
      const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
      const jitter = yield* Random.nextBetween(0.8, 1.2);
      attempt += 1;
      reconnects += 1;
      yield* Effect.sleep(Math.round(base * jitter));
    }
  });

  return { run, sendEvent, sendControl, ack, snapshot };
};

export type HostLinkConnection = ReturnType<typeof makeHostLinkConnection>;
