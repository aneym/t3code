import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { isOwnerCliSubject } from "./McpClientSubjects.ts";
import {
  isFreshOwnerCliCredential,
  OWNER_CLI_CREDENTIAL_PATH,
  type OwnerCliCredential,
  readOwnerCliCredential,
  writeOwnerCliCredential,
} from "./ownerCliCredential.ts";
import * as SessionStore from "./SessionStore.ts";

class OwnerCliCredentialPublisher extends Context.Service<
  OwnerCliCredentialPublisher,
  { readonly ensure: Effect.Effect<void> }
>()("t3/auth/OwnerCliCredentialPublisher") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
  >();
  const lock = yield* Semaphore.make(1);

  const isValid = Effect.fn("OwnerCliCredentialPublisher.isValid")(function* (
    credential: Option.Option<OwnerCliCredential>,
  ) {
    if (Option.isNone(credential) || !(yield* isFreshOwnerCliCredential(credential.value))) {
      return false;
    }
    return yield* sessions.verify(credential.value.token).pipe(
      Effect.map((session) => isOwnerCliSubject(session.subject)),
      Effect.orElseSucceed(() => false),
    );
  });

  const publish = Effect.gen(function* () {
    const current = yield* readOwnerCliCredential(config.secretsDir);
    if (yield* isValid(current)) return;
    const issued = yield* auth.issueMcpClientSession({
      label: "t3 owner cli",
      access: "full-access",
      peerLink: false,
      ownerCli: true,
      client: { deviceType: "bot" },
    });
    yield* writeOwnerCliCredential(config.secretsDir, {
      sessionId: issued.sessionId,
      token: issued.token,
      expiresAtMs: issued.expiresAt.epochMilliseconds,
    }).pipe(Effect.tapError(() => auth.revokeSession(issued.sessionId).pipe(Effect.ignore)));
    if (Option.isSome(current) && current.value.sessionId !== issued.sessionId) {
      yield* auth.revokeSession(current.value.sessionId).pipe(Effect.ignore);
    }
  }).pipe(
    Effect.provide(context),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not publish the owner CLI credential.", cause),
    ),
    Effect.withSpan("OwnerCliCredentialPublisher.publish"),
  );

  return OwnerCliCredentialPublisher.of({ ensure: lock.withPermits(1)(publish) });
});

const layerService = Layer.effect(OwnerCliCredentialPublisher, make);

export const layer = Layer.mergeAll(
  Layer.effectDiscard(
    Effect.flatMap(OwnerCliCredentialPublisher, (publisher) => Effect.forkScoped(publisher.ensure)),
  ),
  Layer.unwrap(
    Effect.gen(function* () {
      const publisher = yield* OwnerCliCredentialPublisher;
      return HttpRouter.add(
        "POST",
        OWNER_CLI_CREDENTIAL_PATH,
        publisher.ensure.pipe(
          Effect.as(
            HttpServerResponse.empty({ status: 204, headers: { "cache-control": "no-store" } }),
          ),
        ),
      );
    }),
  ),
).pipe(Layer.provide(layerService));
