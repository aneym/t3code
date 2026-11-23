import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  connectionRouteId,
  connectionRouteKind,
  connectionRoutes,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentSession } from "../state/session";
import { postToEmbedHost, useEmbedHostConnected } from "./embedHost";
import { embedConnectionRefused } from "./embedKeptViewGate";
import { EMBED_CONNECTION_MESSAGE, type EmbedConnectionReport } from "./embedProtocol";

const connectionReportAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): string | null => {
    const entries = get(environmentCatalog.catalogValueAtom).entries;
    const entry = entries.get(environmentId);
    const report = (fields: Omit<EmbedConnectionReport, "environmentId">) =>
      JSON.stringify({ environmentId, ...fields });
    if (entry === undefined) {
      const loaded = [...entries.values()].some(
        (candidate) => candidate.target._tag === "PrimaryConnectionTarget",
      );
      return loaded
        ? report({ phase: "unknown", reason: null, routeKind: null, hop: null, detail: null })
        : null;
    }
    const state = AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    );
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    const route =
      prepared === null
        ? undefined
        : connectionRoutes(entry).find(
            (candidate) =>
              connectionRouteId(candidate.target) === connectionRouteId(prepared.target),
          );
    const failure = state.phase === "connected" ? null : state.lastFailure;
    return report({
      phase: embedConnectionRefused(state) ? "refused" : state.phase,
      reason: failure?.reason ?? null,
      routeKind: route === undefined ? null : connectionRouteKind(route),
      hop: failure?.hop ?? null,
      detail: failure?.detail ?? null,
    });
  }).pipe(Atom.withLabel(`web-embed-connection-report:${environmentId}`)),
);

export function useEmbedConnectionReport(environmentId: EnvironmentId): void {
  const report = useAtomValue(connectionReportAtom(environmentId));
  const hostConnected = useEmbedHostConnected();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the embedding host each time this chat's connection changes
  useEffect(() => {
    if (report === null || !hostConnected) return;
    const fields = JSON.parse(report) as EmbedConnectionReport;
    postToEmbedHost({ type: EMBED_CONNECTION_MESSAGE, ...fields });
  }, [report, hostConnected]);
}
