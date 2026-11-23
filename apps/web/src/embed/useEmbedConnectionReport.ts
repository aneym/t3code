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
    const routes = connectionRoutes(entry);
    const failure = state.phase === "connected" ? null : state.lastFailure;
    const route =
      prepared === null
        ? failure === null
          ? undefined
          : routes[0]
        : routes.find(
            (candidate) =>
              connectionRouteId(candidate.target) === connectionRouteId(prepared.target),
          );
    return report({
      phase: embedConnectionRefused(state) ? "refused" : state.phase,
      reason: failure?.reason ?? null,
      routeKind:
        failure?.via === "relay"
          ? "relay"
          : route === undefined
            ? null
            : connectionRouteKind(route),
      hop: failure?.hop ?? null,
      detail: failure?.detail ?? null,
    });
  }).pipe(Atom.withLabel(`web-embed-connection-report:${environmentId}`)),
);

const TRANSITION_GAP_MS = 2000;

export function useEmbedConnectionReport(environmentId: EnvironmentId): void {
  const report = useAtomValue(connectionReportAtom(environmentId));
  const hostConnected = useEmbedHostConnected();
  const lastRoute = useRef<{ environmentId: EnvironmentId; kind: string } | null>(null);
  const lastSentAt = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the embedding host when this chat's connection changes, at most one connecting or backoff report per two seconds
  useEffect(() => {
    if (report === null || !hostConnected) return;
    const fields = JSON.parse(report) as EmbedConnectionReport;
    if (fields.routeKind !== null) lastRoute.current = { environmentId, kind: fields.routeKind };
    const attempted =
      lastRoute.current?.environmentId === environmentId ? lastRoute.current.kind : null;
    const post = () => {
      lastSentAt.current = Date.now();
      postToEmbedHost({
        type: EMBED_CONNECTION_MESSAGE,
        ...fields,
        routeKind: fields.routeKind ?? (fields.phase === "unknown" ? null : attempted),
      });
    };
    const wait =
      fields.phase === "connecting" || fields.phase === "backoff"
        ? lastSentAt.current + TRANSITION_GAP_MS - Date.now()
        : 0;
    if (wait <= 0) return post();
    const timer = setTimeout(post, wait);
    return () => clearTimeout(timer);
  }, [environmentId, report, hostConnected]);
}
