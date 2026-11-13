import {
  PEER_LINK_RENEWAL_PATH,
  PEER_LINK_RENEWAL_WINDOW_DAYS,
  PeerLinkRenewedToken,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import { isMcpClientSubject } from "../auth/McpClientSubjects.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as ServerSettings from "../serverSettings.ts";

const RENEWED_LINK_TTL = Duration.days(30);
const RENEWAL_WINDOW_MS = PEER_LINK_RENEWAL_WINDOW_DAYS * 86_400_000;

export class PeerLinkRenewalRefused extends Schema.TaggedError<PeerLinkRenewalRefused>()(
  "PeerLinkRenewalRefused",
  {
    status: Schema.Literals([401, 403, 409]),
    reason: Schema.Literals(["unauthorized", "not_a_link", "renewal_off", "not_due"]),
  },
) {}

export class PeerLinkRenewalGrant extends Context.Service<
  PeerLinkRenewalGrant,
  {
    readonly renew: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      PeerLinkRenewedToken,
      PeerLinkRenewalRefused | SessionStore.SessionCredentialInternalError
    >;
  }
>()("t3/peer/PeerLinkRenewalGrant") {}

const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const lock = yield* Semaphore.make(1);

  const renewOnce = Effect.fn("PeerLinkRenewalGrant.renewOnce")(function* (
    request: HttpServerRequest.HttpServerRequest,
    token: string,
  ) {
    const verified = yield* sessions.verify(token).pipe(
      Effect.asSome,
      Effect.catchIf(SessionStore.isSessionCredentialInvalidError, () => Effect.succeedNone),
    );
    if (Option.isNone(verified)) {
      return yield* new PeerLinkRenewalRefused({ status: 401, reason: "unauthorized" });
    }
    const session = verified.value;
    if (
      session.peerLink !== true ||
      session.method !== "bearer-access-token" ||
      !isMcpClientSubject(session.subject)
    ) {
      return yield* new PeerLinkRenewalRefused({ status: 403, reason: "not_a_link" });
    }
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    if (
      Option.isNone(settings) ||
      !settings.value.linkedEnvironmentsEnabled ||
      !settings.value.peerLinkRenewalEnabled
    ) {
      return yield* new PeerLinkRenewalRefused({ status: 403, reason: "renewal_off" });
    }
    const now = yield* Clock.currentTimeMillis;
    if (
      session.expiresAt === undefined ||
      session.expiresAt.epochMilliseconds - now > RENEWAL_WINDOW_MS
    ) {
      return yield* new PeerLinkRenewalRefused({ status: 409, reason: "not_due" });
    }
    const issued = yield* sessions.issue({
      subject: session.subject,
      method: session.method,
      scopes: session.scopes,
      ttl: RENEWED_LINK_TTL,
      ...(session.runtimeModeCeiling === undefined
        ? {}
        : { runtimeModeCeiling: session.runtimeModeCeiling }),
      peerLink: true,
      client: {
        ...deriveAuthClientMetadata({ request }),
        ...(session.client.label === undefined ? {} : { label: session.client.label }),
        deviceType: "bot",
      },
      replaceSessionId: session.sessionId,
    });
    yield* Effect.logInfo("Renewed a peer link without a pairing code.", {
      client: session.client.label,
      replaced: session.sessionId,
      session: issued.sessionId,
    });
    return { token: issued.token, expiresAt: DateTime.toUtc(issued.expiresAt) };
  });

  const renew: PeerLinkRenewalGrant["Service"]["renew"] = (request) => {
    const token = parseBearerToken(request);
    return token === null
      ? Effect.fail(new PeerLinkRenewalRefused({ status: 401, reason: "unauthorized" }))
      : lock.withPermit(renewOnce(request, token));
  };

  return PeerLinkRenewalGrant.of({ renew });
});

export const layer = Layer.effect(PeerLinkRenewalGrant, make);

const encodeToken = Schema.encodeEffect(Schema.toCodecJson(PeerLinkRenewedToken));

const refused = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers: { "cache-control": "no-store" } });

export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const grant = yield* PeerLinkRenewalGrant;
    return HttpRouter.add(
      "POST",
      PEER_LINK_RENEWAL_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const renewed = yield* grant.renew(request);
        return yield* HttpServerResponse.json(yield* encodeToken(renewed), {
          headers: { "cache-control": "no-store" },
        });
      }).pipe(
        Effect.catchTags({
          PeerLinkRenewalRefused: (refusal) =>
            Effect.succeed(refused(refusal.status, refusal.reason)),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not renew a peer link.", cause).pipe(
            Effect.as(refused(500, "renewal_failed")),
          ),
        ),
      ),
    );
  }),
);
