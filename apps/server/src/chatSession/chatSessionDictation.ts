import { isChatSessionScopes, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ChatThreadSets from "./ChatThreadSets.ts";

const DICTATION_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/api\/voice\/status$/],
  ["GET", /^\/api\/voice\/models$/],
  ["GET", /^\/api\/voice\/cloud\/keys$/],
  ["GET", /^\/api\/voice\/cloud\/openrouter\/models$/],
  ["POST", /^\/api\/voice\/transcribe$/],
  ["POST", /^\/api\/voice\/cloud\/[^/]+\/transcribe$/],
  ["POST", /^\/api\/auth\/websocket-ticket\/media$/],
  ["GET", /^\/ws\/voice$/],
];

export const isDictationRoute = (method: string, path: string) =>
  DICTATION_ROUTES.some(([routeMethod, pattern]) => routeMethod === method && pattern.test(path));

export const ownsChatThreads = Effect.fn("ChatSessionDictation.ownsChatThreads")(function* (
  sets: ChatThreadSets.ChatThreadSets["Service"],
  session: { readonly subject: string; readonly scopes: Iterable<AuthEnvironmentScope> },
) {
  const scopes = [...session.scopes];
  if (!isChatSessionScopes(scopes)) return false;
  const chat = yield* sets
    .forSession({ subject: session.subject, scopes })
    .pipe(Effect.orElseSucceed(() => undefined));
  return chat !== undefined && chat.ownerThreads.size > 0;
});
