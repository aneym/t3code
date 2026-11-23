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

const RECORDED_PAIRS = 16;
const recordedPairs = new Map<string, Promise<EmbedPairResult>>();

async function pairThroughEmbedHost(pair: EmbedPair): Promise<EmbedPairResult> {
  const expectedEnvironmentId = pair.environmentId as EnvironmentId;
  const result = await connectPairing.run(appAtomRegistry, {
    pairingUrl: pair.pairingUrl,
    expectedEnvironmentId,
    alsoAt: pair.alsoAt,
  });
  if (result._tag === "Failure") {
    return {
      requestId: pair.requestId,
      environmentId: pair.environmentId,
      ok: false,
      error: failureText(squashAtomCommandFailure(result)),
    };
  }
  return {
    requestId: pair.requestId,
    environmentId: pair.environmentId,
    ok: true,
    routes: savedRoutes(expectedEnvironmentId),
  };
}

function recordedPair(pair: EmbedPair): Promise<EmbedPairResult> {
  const run = () =>
    pairThroughEmbedHost(pair).catch((error: unknown): EmbedPairResult => ({
      requestId: pair.requestId,
      environmentId: pair.environmentId,
      ok: false,
      error: failureText(error),
    }));
  if (pair.requestId === null) return run();
  const recorded = recordedPairs.get(pair.requestId);
  if (recorded !== undefined) return recorded;
  const result = run();
  recordedPairs.set(pair.requestId, result);
  for (const key of recordedPairs.keys()) {
    if (recordedPairs.size <= RECORDED_PAIRS) break;
    recordedPairs.delete(key);
  }
  return result;
}

export function applyEmbedPair(pair: EmbedPair): void {
  void recordedPair(pair).then((result) =>
    postToEmbedHost({ type: EMBED_PAIR_RESULT_MESSAGE, ...result }),
  );
}
