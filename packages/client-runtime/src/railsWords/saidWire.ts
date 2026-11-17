import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { createProof, type DpopProofKey } from "../relay/dpopProof.ts";

export const RAILS_ORIGIN = "https://one.rails.so";
const PROOF_HEADER = "DPoP";
const BODY_HASH_CLAIM = "bsh";
export const REQUEST_TIMEOUT_MS = 10_000;
const SAID_TEXT_MAX_LENGTH = 20_000;
export const SAID_BODY_MAX_BYTES = 32_000;
export const DEVICE_NAME_MAX_LENGTH = 80;

export const RailsRoute = {
  connect: { method: "POST", path: "/api/t3/connect" },
  device: { method: "GET", path: "/api/t3/device" },
  said: { method: "POST", path: "/api/t3/said" },
} as const;
export type RailsRoute = (typeof RailsRoute)[keyof typeof RailsRoute];

export const SaidBody = Schema.Struct({
  environment: Schema.String.check(Schema.isNonEmpty()),
  thread: Schema.String.check(Schema.isNonEmpty()),
  agent: Schema.String.check(Schema.isNonEmpty()),
  message_id: Schema.String.check(Schema.isNonEmpty()),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(SAID_TEXT_MAX_LENGTH)),
  typed_at: Schema.String.check(Schema.isNonEmpty()),
});
export type SaidBody = typeof SaidBody.Type;

export const ConnectBody = Schema.Struct({
  ticket: Schema.String,
  name: Schema.optionalKey(Schema.String),
});
export type ConnectBody = typeof ConnectBody.Type;

const RailsDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  created_at: Schema.String,
  last_used_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type RailsDevice = typeof RailsDevice.Type;

const DeviceAnswer = Schema.Struct({ device: RailsDevice });
const ErrorAnswer = Schema.Struct({
  error: Schema.String,
  message: Schema.optionalKey(Schema.String),
  rails_epoch: Schema.optionalKey(Schema.Number),
});
const decodeDeviceAnswer = Schema.decodeUnknownOption(DeviceAnswer);
const decodeErrorAnswer = Schema.decodeUnknownOption(ErrorAnswer);

export type RailsAnswer =
  | { readonly kind: "ok"; readonly device: RailsDevice | null }
  | { readonly kind: "retry" }
  | { readonly kind: "clock"; readonly railsEpoch: number }
  | { readonly kind: "removed" }
  | { readonly kind: "refused"; readonly error: string };

export const readRailsAnswer = (status: number, body: unknown): RailsAnswer => {
  if (status >= 200 && status < 300) {
    return { kind: "ok", device: Option.getOrNull(decodeDeviceAnswer(body))?.device ?? null };
  }
  if (status >= 500 || status === 0) return { kind: "retry" };
  const error = Option.getOrNull(decodeErrorAnswer(body));
  if (error?.error === "device_unknown") return { kind: "removed" };
  if (error?.error === "proof_clock" && error.rails_epoch !== undefined) {
    return { kind: "clock", railsEpoch: error.rails_epoch };
  }
  return { kind: "refused", error: error?.error ?? `http_${status}` };
};

const railsUrl = (origin: string, route: RailsRoute) => `${origin}${route.path}`;

export const encodeBody = (body: unknown): Uint8Array =>
  body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));

const bodyHash = (bytes: Uint8Array) =>
  Effect.flatMap(Digest.Digest, (digest) => digest.digest(Digest.sha256, bytes)).pipe(
    Effect.map(Base64Url.encode),
  );

export const signRailsRequest = Effect.fn("RailsWords.signRequest")(function* (input: {
  readonly origin: string;
  readonly route: RailsRoute;
  readonly body?: SaidBody | ConnectBody | undefined;
  readonly key: DpopProofKey;
  readonly clockOffsetSeconds: number;
  readonly nowMillis: number;
}) {
  const url = railsUrl(input.origin, input.route);
  const bytes = encodeBody(input.body);
  const proof = yield* createProof({
    method: input.route.method,
    url,
    key: input.key,
    claims: {
      [BODY_HASH_CLAIM]: yield* bodyHash(bytes),
      iat: Math.floor(input.nowMillis / 1_000) + input.clockOffsetSeconds,
    },
  });
  const headers: Record<string, string> = { [PROOF_HEADER]: proof };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  return { url, method: input.route.method, headers, body: bytes };
});
