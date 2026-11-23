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
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentSession } from "../state/session";
import { postToEmbedHost, useEmbedHostConnected } from "./embedHost";
import { embedFailureCodes } from "./embedFailureCodes";
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
      return loaded ? report({ phase: "unknown", ...embedFailureCodes(null) }) : null;
    }
    const state = AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    );
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    const failure = state.phase === "connected" ? null : state.lastFailure;
    const codes = embedFailureCodes(failure);
    const route =
      prepared === null
        ? undefined
        : connectionRoutes(entry).find(
            (candidate) =>
              connectionRouteId(candidate.target) === connectionRouteId(prepared.target),
          );
    return report({
      phase: embedConnectionRefused(state) ? "refused" : state.phase,
      ...codes,
      routeKind:
        failure === null
          ? route === undefined
            ? null
            : connectionRouteKind(route)
          : codes.routeKind,
    });
  }).pipe(Atom.withLabel(`web-embed-connection-report:${environmentId}`)),
);

const TRANSITION_GAP_MS = 2000;

export function useEmbedConnectionReport(environmentId: EnvironmentId): void {
  const report = useAtomValue(connectionReportAtom(environmentId));
  const hostConnected = useEmbedHostConnected();
  const lastSentAt = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the embedding host when this chat's connection changes, at most one connecting or backoff report per two seconds
  useEffect(() => {
    if (report === null || !hostConnected) return;
    const fields = JSON.parse(report) as EmbedConnectionReport;
    const post = () => {
      lastSentAt.current = Date.now();
      postToEmbedHost({ type: EMBED_CONNECTION_MESSAGE, ...fields });
    };
    const wait =
      fields.phase === "connecting" || fields.phase === "backoff"
        ? lastSentAt.current + TRANSITION_GAP_MS - Date.now()
        : 0;
    if (wait <= 0) return post();
    const timer = setTimeout(post, wait);
    return () => clearTimeout(timer);
  }, [report, hostConnected]);
}
