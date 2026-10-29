import {
  type EnvironmentId,
  PEER_CLIENT_PAIRING_PATH,
  PeerClientPairingCredential,
  PeerLinkError,
  type PeerLinkPairClientResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import { buildPairingUrl } from "../startupAccess.ts";
import * as PeerLinks from "./PeerLinks.ts";

export class PeerClientPairing extends Context.Service<
  PeerClientPairing,
  {
    readonly pairClient: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<PeerLinkPairClientResult, PeerLinkError>;
  }
>()("t3/peer/PeerClientPairing") {}

const decodeCredential = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(PeerClientPairingCredential)),
);
const encodeCredential = Schema.encodeEffect(Schema.toCodecJson(PeerClientPairingCredential));

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const pairClient: PeerClientPairing["Service"]["pairClient"] = Effect.fn(
    "PeerClientPairing.pairClient",
  )(function* (environmentId) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new PeerLinkError({ reason: "storage", message: "Could not read settings.", cause }),
      ),
    );
    if (!settings.linkedEnvironmentsEnabled) {
      return yield* new PeerLinkError({
        reason: "disabled",
        message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
      });
    }
    if (!settings.loadBalancingIncludeLinkedEnvironments) {
      return yield* new PeerLinkError({
        reason: "disabled",
        message: "Linked machines in load balancing is off on this machine.",
      });
    }
    const resolved = yield* links.resolve(environmentId);
    if (resolved.link.access !== "full-access") {
      return yield* new PeerLinkError({
        reason: "disabled",
        message: `${resolved.link.label} is linked without full access, so clients here do not add it.`,
      });
    }
    const unreachable = (cause: unknown) =>
      new PeerLinkError({
        reason: "unreachable",
        message: `${resolved.link.label} did not issue a pairing credential.`,
        cause,
      });
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(`${resolved.url}${PEER_CLIENT_PAIRING_PATH}`).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json",
            authorization: `Bearer ${resolved.token}`,
          }),
        ),
      )
      .pipe(Effect.mapError(unreachable));
    if (response.status === 404) {
      return yield* new PeerLinkError({
        reason: "incompatible",
        message: `${resolved.link.label} runs a T3 Code version that cannot pair clients over a link.`,
      });
    }
    if (response.status !== 200) {
      return yield* unreachable(`HTTP ${response.status}`);
    }
    const issued = yield* response.text.pipe(
      Effect.flatMap(decodeCredential),
      Effect.mapError(unreachable),
    );
    return { pairingUrl: buildPairingUrl(resolved.url, issued.credential) };
  });

  return PeerClientPairing.of({ pairClient });
});

export const layer = Layer.effect(PeerClientPairing, make);

const refused = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers: { "cache-control": "no-store" } });

export const routeLayer = HttpRouter.add(
  "POST",
  PEER_CLIENT_PAIRING_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
    if (Option.isNone(client)) return refused(401, "unauthorized");
    if (!client.value.peerLink || client.value.access !== "full-access") {
      return refused(403, "full_access_link_required");
    }
    const enabled = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.linkedEnvironmentsEnabled),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return refused(403, "linked_environments_off");
    const issued = yield* auth.issuePairingCredential({
      label: `Linked route via ${client.value.label}`,
    });
    return yield* HttpServerResponse.json(
      yield* encodeCredential({
        credential: issued.credential,
        expiresAt: issued.expiresAt,
      }),
      { headers: { "cache-control": "no-store" } },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not issue a client pairing credential over a link.", cause).pipe(
        Effect.as(refused(500, "pairing_failed")),
      ),
    ),
  ),
);
