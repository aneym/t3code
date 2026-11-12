import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as ServerConfig from "../config.ts";

type Fields = Record<string, string | number | boolean>;

interface CurrentRequestEntry {
  readonly fields: Fields;
  readonly write: (fields: Fields) => void;
}

const CurrentRequest = Context.Reference<CurrentRequestEntry | undefined>(
  "t3/observability/RequestLog/CurrentRequest",
  { defaultValue: () => undefined },
);

const SIGNED_PREFIXES = ["/api/assets", "/api/hooks", "/api/attachments/upload"];
const OPAQUE_SEGMENT = /^[A-Za-z0-9_~.%=-]{24,}$/;
const MAX_BUFFER_BYTES = 1024 * 1024;
const FLUSH_EVERY = "1 second";

const routeOf = (url: string) => {
  const queryIndex = url.indexOf("?");
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const signed = SIGNED_PREFIXES.find((prefix) => path.startsWith(`${prefix}/`));
  if (signed !== undefined) return `${signed}/*`;
  const segments = path.split("/").slice(0, 7);
  return segments
    .map((segment) => (OPAQUE_SEGMENT.test(segment) ? ":id" : segment.slice(0, 48)))
    .join("/");
};

const productToken = (userAgent: string | undefined) =>
  userAgent === undefined || userAgent.length === 0
    ? "-"
    : userAgent.split(" ", 1)[0]!.slice(0, 48);

const shortId = (id: string) => id.slice(0, 12);

const surfaceOf = (url: string) => {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return undefined;
  const surface = new URLSearchParams(url.slice(queryIndex + 1)).get("clientSurface");
  return surface !== null && /^[a-z-]{1,16}$/.test(surface) ? surface : undefined;
};

const statusOf = (exit: Exit.Exit<{ readonly status: number }, unknown>) =>
  Exit.isSuccess(exit) ? exit.value.status : Cause.hasInterruptsOnly(exit.cause) ? 499 : 500;

const note = Effect.fn("RequestLog.note")(function* (update: Fields) {
  const entry = yield* CurrentRequest;
  if (entry !== undefined) Object.assign(entry.fields, update);
});

export const noteSession = (session: { readonly sessionId: string; readonly method: string }) =>
  note({ sid: shortId(session.sessionId), auth: session.method });

export const noteMcpCaller = (caller: {
  readonly thread: { readonly threadId: string } | undefined;
  readonly client: { readonly sessionId: string; readonly label: string } | undefined;
}) =>
  note(
    caller.client !== undefined
      ? { sid: shortId(caller.client.sessionId), client: caller.client.label.slice(0, 48) }
      : caller.thread !== undefined
        ? { thread: caller.thread.threadId }
        : {},
  );

export const noteTool = (tool: string) => note({ tool });

export const logRpc = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.service(CurrentRequest), (entry) =>
    entry === undefined
      ? effect
      : Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
          effect.pipe(
            Effect.onExit((exit) =>
              Effect.map(Clock.currentTimeMillis, (endedAt) =>
                entry.write({
                  ...entry.fields,
                  k: "rpc",
                  rpc: method,
                  end: Exit.isSuccess(exit)
                    ? "ok"
                    : Cause.hasInterruptsOnly(exit.cause)
                      ? "closed"
                      : "err",
                  ms: endedAt - startedAt,
                }),
              ),
            ),
          ),
        ),
  );

const makeWriter = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const maxBytes = yield* Config.Int("T3CODE_REQUEST_LOG_MAX_BYTES").pipe(
    Effect.map((bytes) => Math.max(64 * 1024, bytes)),
    Effect.orElseSucceed(() => 8 * 1024 * 1024),
  );
  const sink = yield* makeAsyncRotatingFileSink({
    filePath: path.join(config.logsDir, "server.requests.ndjson"),
    maxBytes,
    maxFiles: 2,
  });
  let buffer: Array<string> = [];
  let bufferBytes = 0;
  let dropped = 0;
  const flush = Effect.suspend(() => {
    if (dropped > 0) {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      buffer.push(`${JSON.stringify({ k: "dropped", n: dropped })}\n`);
      dropped = 0;
    }
    if (buffer.length === 0) return Effect.void;
    const chunk = buffer.join("");
    buffer = [];
    bufferBytes = 0;
    return sink.write(chunk).pipe(Effect.ignore);
  });
  yield* flush.pipe(Effect.repeat(Schedule.spaced(FLUSH_EVERY)), Effect.forkScoped);
  yield* Effect.addFinalizer(() => flush);
  return (fields: Fields) => {
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const line = `${JSON.stringify({ t: DateTime.formatIso(DateTime.nowUnsafe()), ...fields })}\n`;
    if (bufferBytes + line.length > MAX_BUFFER_BYTES) {
      dropped += 1;
      return;
    }
    buffer.push(line);
    bufferBytes += line.length;
  };
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("T3CODE_REQUEST_LOG").pipe(
      Effect.orElseSucceed(() => true),
    );
    const write = enabled
      ? yield* makeWriter.pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    if (write === undefined) return Layer.empty;
    return HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const surface = surfaceOf(request.url);
          const fields: Fields = {
            k: "http",
            m: request.method,
            p: routeOf(request.url),
            ua: productToken(request.headers["user-agent"]),
            ...(surface === undefined ? {} : { surface }),
          };
          const startedAt = yield* Clock.currentTimeMillis;
          return yield* httpEffect.pipe(
            Effect.provideService(CurrentRequest, { fields, write }),
            Effect.onExit((exit) =>
              Effect.map(Clock.currentTimeMillis, (endedAt) =>
                write({ ...fields, s: statusOf(exit), ms: endedAt - startedAt }),
              ),
            ),
          );
        }),
      { global: true },
    );
  }),
);
