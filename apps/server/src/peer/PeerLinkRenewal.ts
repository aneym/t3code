import {
  type EnvironmentId,
  PEER_LINK_RENEWAL_PATH,
  type PeerLink,
  PeerLinkError,
  PeerLinkRenewedToken,
  peerLinkRenewsFromMs,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

interface ResolvedLink {
  readonly link: PeerLink;
  readonly url: string;
  readonly token: string;
}

export interface PeerLinkRenewalDeps {
  readonly sql: SqlClient.SqlClient;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly crypto: Crypto.Crypto;
  readonly httpClient: HttpClient.HttpClient;
  readonly enabled: Effect.Effect<boolean>;
  readonly disabledMessage: string;
  readonly get: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<Option.Option<PeerLink>, PeerLinkError>;
  readonly stored: Effect.Effect<ReadonlyArray<PeerLink>, PeerLinkError>;
  readonly resolve: (environmentId: EnvironmentId) => Effect.Effect<ResolvedLink, PeerLinkError>;
}

const decodeRenewed = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(PeerLinkRenewedToken)),
);

class PeerRefusedRenewal extends Schema.TaggedError<PeerRefusedRenewal>()("PeerRefusedRenewal", {
  error: PeerLinkError,
}) {}

const storageError = (cause: unknown) =>
  new PeerLinkError({
    reason: "storage",
    message: "The renewed link could not be saved here. The server log has details.",
    cause,
  });

export const makePeerLinkRenewal = (deps: PeerLinkRenewalDeps) => {
  const { sql, secrets, crypto, httpClient } = deps;

  const secretNameOf = (environmentId: EnvironmentId) =>
    sql<{ secret_name: string }>`
      SELECT secret_name FROM peer_environment_links WHERE environment_id = ${environmentId}
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.secret_name)),
      Effect.mapError(storageError),
    );

  const recordRefusal = (environmentId: EnvironmentId, secretName: string, message: string) =>
    sql`
      UPDATE peer_environment_links SET renewal_error = ${message}
      WHERE environment_id = ${environmentId} AND secret_name = ${secretName}
    `.pipe(Effect.ignoreCause({ log: true }));

  const askPeer = Effect.fn("PeerLinkRenewal.askPeer")(function* (resolved: ResolvedLink) {
    const name = resolved.link.label;
    const unreachable = (cause: unknown) =>
      new PeerLinkError({
        reason: "unreachable",
        message: `${name} did not answer the renewal.`,
        cause,
      });
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(`${resolved.url}${PEER_LINK_RENEWAL_PATH}`).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json",
            authorization: `Bearer ${resolved.token}`,
          }),
        ),
      )
      .pipe(Effect.mapError(unreachable));
    if (response.status === 200) {
      return yield* response.text.pipe(Effect.flatMap(decodeRenewed), Effect.mapError(unreachable));
    }
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const refusal = (reason: PeerLinkError["reason"], message: string) =>
      new PeerRefusedRenewal({ error: new PeerLinkError({ reason, message }) });
    if (response.status === 404) {
      return yield* refusal(
        "incompatible",
        `${name} runs a T3 Code version that cannot renew links. Link it again with a new pairing code.`,
      );
    }
    if (response.status === 401) {
      return yield* refusal(
        "expired",
        `${name} no longer accepts this link: it was revoked or expired there. Link it again with a new pairing code.`,
      );
    }
    if (response.status === 403 && body.includes("renewal_off")) {
      return yield* refusal(
        "disabled",
        `${name} does not renew links without a pairing code. Turn on Renew links without a code in its Settings → Connections, or link it again.`,
      );
    }
    if (response.status === 403) {
      return yield* refusal("incompatible", `${name} does not treat this as a renewable link.`);
    }
    if (response.status === 409) {
      return yield* new PeerLinkError({
        reason: "not_due",
        message: `${name} says the link is not in its last days yet. Check both machines' clocks.`,
      });
    }
    return yield* unreachable(`HTTP ${response.status}`);
  });

  const renew = Effect.fn("PeerLinkRenewal.renew")(function* (environmentId: EnvironmentId) {
    if (!(yield* deps.enabled)) {
      return yield* new PeerLinkError({
        reason: "disabled",
        message: deps.disabledMessage,
      });
    }
    const stored = yield* deps.get(environmentId);
    const secretName = yield* secretNameOf(environmentId);
    if (Option.isNone(stored) || Option.isNone(secretName)) {
      return yield* new PeerLinkError({
        reason: "unknown_link",
        message: `This environment is not linked to ${environmentId}.`,
      });
    }
    const link = stored.value;
    const now = yield* DateTime.now;
    if (DateTime.isLessThanOrEqualTo(link.expiresAt, now)) {
      return yield* new PeerLinkError({
        reason: "expired",
        message: `The link to ${link.label} expired, so it cannot be renewed. Link it again with a new pairing code from ${link.label}.`,
      });
    }
    const renewsFrom = DateTime.makeUnsafe(peerLinkRenewsFromMs(link));
    if (DateTime.isLessThan(now, renewsFrom)) {
      return yield* new PeerLinkError({
        reason: "not_due",
        message: `The link to ${link.label} renews only in its last days, from ${DateTime.formatIso(renewsFrom)}.`,
      });
    }
    const resolved = yield* deps.resolve(environmentId);
    const renewed = yield* askPeer(resolved).pipe(
      Effect.catchTags({
        PeerRefusedRenewal: ({ error }) =>
          recordRefusal(environmentId, secretName.value, error.message).pipe(
            Effect.andThen(Effect.fail(error)),
          ),
      }),
    );
    const nextSecret = `peer-link-${Hex.encode(yield* crypto.randomBytes(16).pipe(Effect.orDie))}`;
    yield* secrets
      .set(nextSecret, new TextEncoder().encode(renewed.token))
      .pipe(Effect.mapError(storageError));
    const renewedAt = DateTime.formatIso(yield* DateTime.now);
    const updated = yield* sql<{ environment_id: string }>`
        UPDATE peer_environment_links
        SET secret_name = ${nextSecret}, expires_at = ${DateTime.formatIso(renewed.expiresAt)},
          renewed_at = ${renewedAt}, renewal_error = NULL, last_reached_at = ${renewedAt},
          last_error = NULL
        WHERE environment_id = ${environmentId} AND secret_name = ${secretName.value}
        RETURNING environment_id
      `.pipe(
      Effect.mapError(storageError),
      Effect.onError(() => secrets.remove(nextSecret).pipe(Effect.ignore)),
    );
    if (updated.length === 0) {
      yield* secrets.remove(nextSecret).pipe(Effect.ignore);
      return yield* new PeerLinkError({
        reason: "storage",
        message: `The link to ${link.label} changed while it was renewing. List it again.`,
      });
    }
    yield* secrets.remove(secretName.value).pipe(Effect.ignore);
    yield* Effect.logInfo("Renewed a peer link without a pairing code.", {
      environmentId,
      expiresAt: DateTime.formatIso(renewed.expiresAt),
    });
    const saved = yield* deps.get(environmentId);
    return Option.getOrElse(saved, () => ({ ...link, expiresAt: renewed.expiresAt }));
  });

  const renewDue = Effect.gen(function* () {
    if (!(yield* deps.enabled)) return;
    const now = yield* DateTime.now;
    const due = (yield* deps.stored).filter(
      (link) =>
        DateTime.isGreaterThan(link.expiresAt, now) &&
        now.epochMilliseconds >= peerLinkRenewsFromMs(link),
    );
    yield* Effect.forEach(
      due,
      (link) =>
        renew(link.environmentId).pipe(
          Effect.catch((error) =>
            Effect.logInfo("A peer link was not renewed.", {
              environmentId: link.environmentId,
              reason: error.reason,
              message: error.message,
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(Effect.catch((cause) => Effect.logWarning("Peer link renewal sweep failed.", cause)));

  return { renew, renewDue };
};
