import { connectionRoutes, routeHttpBaseUrl } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { postToEmbedHost } from "./embedHost";
import { EMBED_PAIR_RESULT_MESSAGE, type EmbedPair, type EmbedPairResult } from "./embedProtocol";

function savedRoutes(environmentId: EnvironmentId): ReadonlyArray<string> {
  const entry = appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  return entry === undefined
    ? []
    : connectionRoutes(entry).flatMap((route) => routeHttpBaseUrl(route) ?? []);
}

function failureText(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 400)
    : "Pairing failed.";
}

async function pairThroughEmbedHost(pair: EmbedPair): Promise<EmbedPairResult> {
  const expectedEnvironmentId = pair.environmentId as EnvironmentId;
  const result = await connectPairing.run(appAtomRegistry, {
    pairingUrl: pair.pairingUrl,
    expectedEnvironmentId,
    alsoAt: pair.alsoAt,
  });
  if (result._tag === "Failure") {
    return {
      environmentId: pair.environmentId,
      ok: false,
      error: failureText(squashAtomCommandFailure(result)),
    };
  }
  return {
    environmentId: pair.environmentId,
    ok: true,
    routes: savedRoutes(expectedEnvironmentId),
  };
}

export function applyEmbedPair(pair: EmbedPair): void {
  void pairThroughEmbedHost(pair)
    .catch((error: unknown) => ({
      environmentId: pair.environmentId,
      ok: false,
      error: failureText(error),
    }))
    .then((result) => postToEmbedHost({ type: EMBED_PAIR_RESULT_MESSAGE, ...result }));
}
