import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { useEffect, useRef, useState } from "react";

import { useChatSession, useChatSessionListsThread } from "../chatSessionMode";
import { environmentCatalog } from "../connection/catalog";
import { fetchSessionState } from "../environments/primary/auth";
import { serverEnvironment } from "../state/server";
import { useEnvironmentThread } from "../state/threads";
import { embedConnectionRefused, embedKeptView, type EmbedKeptView } from "./embedKeptViewGate";
import {
  noteKeptViewShown,
  reopenKeptViews,
  retainKeptViewsOf,
  wipeKeptViews,
} from "./embedKeptViews";

export const liveConfigAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ServerConfig | null => {
    const projection = AsyncResult.getOrElse(
      get(serverEnvironment.configProjection({ environmentId, input: {} })),
      () => null,
    );
    return projection?.source === "live" ? projection.config : null;
  }).pipe(Atom.withLabel(`web-embed-live-config:${environmentId}`)),
);
const NO_LIVE_CONFIG_ATOM = Atom.make((): ServerConfig | null => null).pipe(
  Atom.withLabel("web-embed-live-config:none"),
);

const connectionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    ),
  ).pipe(Atom.withLabel(`web-embed-connection:${environmentId}`)),
);
const NO_CONNECTION_ATOM = Atom.make(() => AVAILABLE_CONNECTION_STATE).pipe(
  Atom.withLabel("web-embed-connection:none"),
);

function useLiveConfig(environmentId: EnvironmentId | null): ServerConfig | null {
  return useAtomValue(environmentId === null ? NO_LIVE_CONFIG_ATOM : liveConfigAtom(environmentId));
}

export function useEmbedKeptView(threadRef: ScopedThreadRef | null): EmbedKeptView {
  const thread = useEnvironmentThread(
    threadRef?.environmentId ?? null,
    threadRef?.threadId ?? null,
  );
  const chatSession = useChatSession();
  const liveConfig = useLiveConfig(threadRef?.environmentId ?? null);
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const sessionListsThread = useChatSessionListsThread(threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records when this thread was last shown, for least recently shown eviction in IndexedDB
  useEffect(() => {
    if (environmentId !== null && threadId !== null) noteKeptViewShown(environmentId, threadId);
  }, [environmentId, threadId]);
  if (threadRef === null) return "live";
  return embedKeptView({
    threadId: threadRef.threadId,
    status: thread.status,
    hasData: Option.isSome(thread.data),
    chatSession,
    liveConfig,
    sessionListsThread,
  });
}

export function useEmbedKeptViewUpkeep(
  authenticated: boolean,
  environmentId: EnvironmentId | null,
): boolean {
  const liveEnvironmentId = useLiveConfig(authenticated ? environmentId : null)?.environment
    .environmentId;
  const connection = useAtomValue(
    environmentId === null ? NO_CONNECTION_ATOM : connectionAtom(environmentId),
  );
  const [refusedSession, setRefusedSession] = useState(false);
  const connected = connection.phase === "connected";
  const signedOut = refusedSession && !connected;
  const refused = embedConnectionRefused(connection);
  const wasConnected = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server whether this frame is still signed in when its socket drops or is refused, and wipes the kept views in IndexedDB when it is not
  useEffect(() => {
    if (!authenticated) return;
    if (connected) {
      wasConnected.current = true;
      reopenKeptViews();
      return;
    }
    if (!wasConnected.current && !refused) return;
    let current = true;
    void fetchSessionState()
      .then((session) => {
        if (!current) return;
        setRefusedSession(!session.authenticated);
        if (!session.authenticated) return wipeKeptViews();
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [authenticated, connected, refused]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops every kept view in IndexedDB once the server says this frame is signed out or its pairing is gone
  useEffect(() => {
    if (!authenticated) void wipeKeptViews().catch(() => undefined);
  }, [authenticated]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops kept views of any other environment once the live server names its own
  useEffect(() => {
    if (liveEnvironmentId !== undefined) {
      void retainKeptViewsOf(liveEnvironmentId).catch(() => undefined);
    }
  }, [liveEnvironmentId]);
  return authenticated && !signedOut;
}
