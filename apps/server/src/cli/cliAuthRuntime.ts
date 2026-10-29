import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";

export class CliDatabaseMissingError extends Schema.TaggedError<CliDatabaseMissingError>()(
  "CliDatabaseMissingError",
  { dbPath: Schema.String },
) {
  override get message(): string {
    return `T3 Code's database is not at ${this.dbPath}. The server may be restarting; start T3 Code, then retry.`;
  }
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath, serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = (path: string) =>
      fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
    if ((yield* exists(serverRuntimeStatePath)) && !(yield* exists(dbPath))) {
      return yield* new CliDatabaseMissingError({ dbPath });
    }
    return EnvironmentAuth.layerRuntime;
  }),
);

export const withProjectCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthStandardClientScopes,
      label: "t3 project cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );
