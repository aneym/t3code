import {
  AuthSessionId,
  ServerAuthSessionRevokeResult,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ownerMcpToolsAt } from "./ownerMcpTools.ts";

const IssuedToken = Schema.Struct({ sessionId: AuthSessionId, token: Schema.String });

export const withServerIssuedSession = <A, E, R>(
  target: { readonly secretsDir: string; readonly origin: string; readonly command: string },
  session: {
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly label: string;
    readonly subject?: string;
  },
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const tools = yield* ownerMcpToolsAt(target.secretsDir, target.origin, target.command);
      return yield* Effect.acquireUseRelease(
        tools.call("t3_auth_session_issue", session, IssuedToken),
        (issued) => run(issued.token),
        (issued) =>
          tools
            .call(
              "t3_auth_session_revoke",
              { sessionId: issued.sessionId },
              ServerAuthSessionRevokeResult,
            )
            .pipe(Effect.ignore({ log: true })),
      );
    }),
  );
