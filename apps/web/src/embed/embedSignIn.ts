import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { getPairingTokenFromUrl, stripPairingTokenFromUrl } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

export type EmbedSignIn = "none" | "signed-in" | "expired";

let bearerToken: string | null = null;
let signIn: EmbedSignIn = "none";
let pending: Promise<EmbedSignIn> | null = null;

export function readEmbedBearerToken(): string | null {
  return bearerToken;
}

export function readEmbedSignIn(): EmbedSignIn {
  return signIn;
}

function takeCredentialFromUrl(): string | null {
  const url = new URL(window.location.href);
  const credential = getPairingTokenFromUrl(url);
  if (credential === null) return null;
  const stripped = stripPairingTokenFromUrl(url);
  stripped.hash = "";
  window.history.replaceState(window.history.state, "", stripped.toString());
  return credential;
}

async function exchange(credential: string): Promise<EmbedSignIn> {
  try {
    const result = await Effect.runPromise(
      bootstrapRemoteBearerSession({
        httpBaseUrl: resolvePrimaryEnvironmentHttpUrl("/"),
        credential,
      }).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch))),
    );
    bearerToken = result.access_token;
    signIn = "signed-in";
  } catch {
    bearerToken = null;
    signIn = "expired";
  }
  return signIn;
}

export function signInEmbedFromUrl(): Promise<EmbedSignIn> {
  const credential = takeCredentialFromUrl();
  if (credential !== null) {
    pending = exchange(credential);
  }
  return pending ?? Promise.resolve(signIn);
}
