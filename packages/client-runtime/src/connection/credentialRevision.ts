import { type ConnectionAttemptError, ConnectionBlockedError } from "./model.ts";

const hash32 = (text: string, seed: number): number => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
};

export function credentialRevision(token: string): string {
  return [1, 2, 3, 4].map((seed) => hash32(token, seed).toString(16).padStart(8, "0")).join("");
}

export const withCredentialRevision = (
  failure: ConnectionAttemptError,
  token: string,
): ConnectionAttemptError =>
  failure._tag === "ConnectionBlockedError" &&
  failure.failureCause === "chat_session_forbidden" &&
  failure.credentialRevision === undefined
    ? new ConnectionBlockedError({ ...failure, credentialRevision: credentialRevision(token) })
    : failure;
