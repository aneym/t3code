import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { isOwnerCliSubject } from "./McpClientSubjects.ts";
import {
  OWNER_CLI_CREDENTIAL_PATH,
  readOwnerCliCredential,
  writeOwnerCliCredential,
} from "./ownerCliCredential.ts";
import * as OwnerCliCredentialPublisher from "./OwnerCliCredentialPublisher.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-owner-cli-credential-test-" }),
  ),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "OwnerCliCredentialPublisher",
  (it) => {
    it.effect(
      "keeps one private owner CLI credential, replaces it only once it stops working, and revokes the one it replaces",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const auth = yield* Layer.build(layerAuth);
            yield* HttpRouter.serve(
              OwnerCliCredentialPublisher.layer.pipe(Layer.provide(Layer.succeedContext(auth))),
              { disableListenLog: true, disableLogger: true },
            ).pipe(Layer.build);
            const config = yield* Effect.provide(ServerConfig.ServerConfig, auth);
            const sessions = yield* Effect.provide(SessionStore.SessionStore, auth);
            const environmentAuth = yield* Effect.provide(EnvironmentAuth.EnvironmentAuth, auth);
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const httpClient = yield* HttpClient.HttpClient;

            const publish = Effect.gen(function* () {
              const response = yield* httpClient.post(OWNER_CLI_CREDENTIAL_PATH);
              expect(response.status).toBe(204);
              expect(yield* response.text).toBe("");
              return Option.getOrThrow(yield* readOwnerCliCredential(config.secretsDir));
            });

            const first = yield* publish;
            const info = yield* fileSystem.stat(
              path.join(config.secretsDir, "owner-cli-session.json"),
            );
            expect(info.mode & 0o777).toBe(0o600);
            expect(isOwnerCliSubject((yield* sessions.verify(first.token)).subject)).toBe(true);

            expect((yield* publish).sessionId).toBe(first.sessionId);

            yield* environmentAuth.revokeSession(first.sessionId);
            const replaced = yield* publish;
            expect(replaced.sessionId).not.toBe(first.sessionId);
            expect(isOwnerCliSubject((yield* sessions.verify(replaced.token)).subject)).toBe(true);
            expect(yield* sessions.verify(first.token).pipe(Effect.isFailure)).toBe(true);

            yield* fileSystem.remove(path.join(config.secretsDir, "owner-cli-session.json"));
            const afterMissing = yield* publish;
            expect(afterMissing.sessionId).not.toBe(replaced.sessionId);
            expect(yield* sessions.verify(replaced.token).pipe(Effect.isFailure)).toBe(true);

            yield* writeOwnerCliCredential(config.secretsDir, { ...afterMissing, expiresAtMs: 0 });
            const afterExpiry = yield* publish;
            expect(afterExpiry.sessionId).not.toBe(afterMissing.sessionId);
            expect(yield* sessions.verify(afterMissing.token).pipe(Effect.isFailure)).toBe(true);
            expect(isOwnerCliSubject((yield* sessions.verify(afterExpiry.token)).subject)).toBe(
              true,
            );
          }),
        ).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  },
);
