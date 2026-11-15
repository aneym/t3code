import { CHAT_SESSION_TTL_MS, isChatSessionScopes } from "@t3tools/contracts";
import * as Duration from "effect/Duration";

const CHAT_SESSION_TTL = Duration.millis(CHAT_SESSION_TTL_MS);

export const sessionTtlFor = (
  scopes: ReadonlyArray<string> | undefined,
  ttl: Duration.Duration,
): Duration.Duration => (isChatSessionScopes(scopes) ? Duration.min(ttl, CHAT_SESSION_TTL) : ttl);

const CHAT_SESSION_RECHECK_MS = 5_000;

export const sessionRecheckMs = (scopes: ReadonlyArray<string>, remainingMs: number): number =>
  isChatSessionScopes(scopes) ? Math.min(remainingMs, CHAT_SESSION_RECHECK_MS) : remainingMs;
