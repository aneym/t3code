import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import { makeNdjsonLogWriter } from "./NdjsonLogWriter.ts";

type Fields = Record<string, string | number | boolean>;

interface CurrentRequestEntry {
  readonly fields: Fields;
  readonly write: (fields: Fields) => void;
}

const CurrentRequest = Context.Reference<CurrentRequestEntry | undefined>(
  "t3/observability/RequestLog/CurrentRequest",
  { defaultValue: () => undefined },
);

const CurrentRpc = Context.Reference<CurrentRequestEntry | undefined>(
  "t3/observability/RequestLog/CurrentRpc",
  { defaultValue: () => undefined },
);

const currentEntry = Effect.map(
  Effect.zip(Effect.service(CurrentRpc), Effect.service(CurrentRequest)),
  ([rpc, request]) => rpc ?? request,
);

const SIGNED_PREFIXES = ["/api/assets", "/api/hooks", "/api/attachments/upload"];
const OPAQUE_SEGMENT = /^[A-Za-z0-9_~.%=-]{24,}$/;

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

const surfaceOf = (url: string) => {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return undefined;
  const surface = new URLSearchParams(url.slice(queryIndex + 1)).get("clientSurface");
  return surface !== null && /^[a-z-]{1,16}$/.test(surface) ? surface : undefined;
};

const statusOf = (exit: Exit.Exit<{ readonly status: number }, unknown>) =>
  Exit.isSuccess(exit) ? exit.value.status : Cause.hasInterruptsOnly(exit.cause) ? 499 : 500;

export const noteDispatchGate = Effect.fnUntraced(function* (waitMs: number, holdMs: number) {
  const entry = yield* currentEntry;
  if (entry === undefined) return;
  const { gw, gh } = entry.fields;
  entry.fields.gw = (typeof gw === "number" ? gw : 0) + waitMs;
  entry.fields.gh = (typeof gh === "number" ? gh : 0) + holdMs;
});

export const logRpc = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.service(CurrentRequest), (entry) =>
    entry === undefined
      ? effect
      : Effect.flatMap(Clock.currentTimeMillis, (startedAt) => {
          const rpcEntry = { fields: { ...entry.fields }, write: entry.write };
          return effect.pipe(
            Effect.provideService(CurrentRpc, rpcEntry),
            Effect.onExit((exit) =>
              Effect.map(Clock.currentTimeMillis, (endedAt) =>
                entry.write({
                  ...rpcEntry.fields,
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
          );
        }),
  );

const makeWriter = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const maxBytes = yield* Config.Int("T3CODE_REQUEST_LOG_MAX_BYTES").pipe(
    Effect.map((bytes) => Math.max(64 * 1024, bytes)),
    Effect.orElseSucceed(() => 8 * 1024 * 1024),
  );
  return yield* makeNdjsonLogWriter({
    filePath: path.join(config.logsDir, "server.requests.ndjson"),
    maxBytes,
  });
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
