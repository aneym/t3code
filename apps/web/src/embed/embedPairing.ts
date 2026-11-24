import { connectionRoutes, routeHttpBaseUrl } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { commitPairing } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { embedFailureCodes } from "./embedFailureCodes";
import { postToEmbedHost } from "./embedHost";
import { grantKeptViews } from "./embedKeptViews";
import { EMBED_PAIR_RESULT_MESSAGE, type EmbedPair, type EmbedPairResult } from "./embedProtocol";

function savedRoutes(environmentId: EnvironmentId): ReadonlyArray<string> {
  const entry = appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  return entry === undefined
    ? []
    : connectionRoutes(entry).flatMap((route) => routeHttpBaseUrl(route) ?? []);
}

function failed(pair: EmbedPair, error: unknown): EmbedPairResult {
  const codes = embedFailureCodes(error);
  return {
    requestId: pair.requestId,
    environmentId: pair.environmentId,
    ok: false,
    error: codes.reason ?? "pairing-failed",
    ...(codes.failureCause === null ? {} : { failureCause: codes.failureCause }),
  };
}

const COMPLETED_PAIRS = 16;
const pendingPairs = new Map<string, Promise<EmbedPairResult>>();
const completedPairs = new Map<string, EmbedPairResult>();

async function pairThroughEmbedHost(pair: EmbedPair): Promise<EmbedPairResult> {
  const expectedEnvironmentId = pair.environmentId as EnvironmentId;
  const result = await commitPairing.run(appAtomRegistry, {
    pairingUrl: pair.pairingUrl,
    expectedEnvironmentId,
    alsoAt: pair.alsoAt,
  });
  if (result._tag === "Failure") return failed(pair, squashAtomCommandFailure(result));
  await grantKeptViews(expectedEnvironmentId, result.value.credentialRevision).catch(
    () => undefined,
  );
  return {
    requestId: pair.requestId,
    environmentId: pair.environmentId,
    ok: true,
    routes: savedRoutes(expectedEnvironmentId),
  };
}

function complete(requestId: string, result: EmbedPairResult): EmbedPairResult {
  pendingPairs.delete(requestId);
  completedPairs.set(requestId, result);
  for (const key of completedPairs.keys()) {
    if (completedPairs.size <= COMPLETED_PAIRS) break;
    completedPairs.delete(key);
  }
  return result;
}

function recordedPair(pair: EmbedPair): Promise<EmbedPairResult> {
  const run = () => pairThroughEmbedHost(pair).catch((error: unknown) => failed(pair, error));
  const { requestId } = pair;
  if (requestId === null) return run();
  const completed = completedPairs.get(requestId);
  if (completed !== undefined) return Promise.resolve(completed);
  const pending = pendingPairs.get(requestId);
  if (pending !== undefined) return pending;
  const result = run().then((outcome) => complete(requestId, outcome));
  pendingPairs.set(requestId, result);
  return result;
}

export function applyEmbedPair(pair: EmbedPair): void {
  void recordedPair(pair).then((result) =>
    postToEmbedHost({ type: EMBED_PAIR_RESULT_MESSAGE, ...result }),
  );
}
