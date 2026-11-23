import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { useEffect, useRef, useState } from "react";

import { useChatSession, useChatSessionListsThread } from "../chatSessionMode";
import { environmentCatalog } from "../connection/catalog";
import { fetchSessionState } from "../environments/primary/auth";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { environmentThreads, useEnvironmentThread } from "../state/threads";
import { embedConnectionRefused, embedKeptView, type EmbedKeptView } from "./embedKeptViewGate";
import {
  type KeptViewAccess,
  loadKeptViewAccess,
  noteKeptViewShown,
  onKeptViewAccessChange,
  refuseKeptViews,
  reopenKeptViews,
  retainKeptViewsOf,
  wipeKeptViews,
} from "./embedKeptViews";
import { embedSessionAdmitsThread } from "./embedParentThread";

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
  const shell = useThreadShell(threadRef);
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
    sessionChild:
      chatSession &&
      shell?.lineage.relationshipToParent === "subagent" &&
      embedSessionAdmitsThread(threadRef, liveConfig),
  });
}

const keptEnvironmentsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const entries = get(environmentCatalog.catalogValueAtom).entries;
    const entry = entries.get(environmentId);
    const hasPrimary = [...entries.values()].some(
      (candidate) => candidate.target._tag === "PrimaryConnectionTarget",
    );
    return {
      saved: entry !== undefined && entry.target._tag !== "PrimaryConnectionTarget",
      keep: hasPrimary ? [...entries.keys()].toSorted().join("\n") : null,
    };
  }).pipe(Atom.withLabel(`web-embed-kept-environments:${environmentId}`)),
);
const NO_KEPT_ENVIRONMENTS_ATOM = Atom.make(() => ({ saved: false, keep: null })).pipe(
  Atom.withLabel("web-embed-kept-environments:none"),
);

const keptViewAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): KeptViewAccess | null => {
    let live = true;
    const read = () =>
      void loadKeptViewAccess(environmentId).then(
        (access) => {
          if (live) get.setSelf(access);
        },
        () => {
          if (live) get.setSelf({ generation: 0, refused: false });
        },
      );
    const stop = onKeptViewAccessChange((changed) => {
      if (changed === environmentId) read();
    });
    get.addFinalizer(() => {
      live = false;
      stop();
    });
    read();
    return null;
  }).pipe(Atom.withLabel(`web-embed-kept-view-access:${environmentId}`)),
);

type SavedAccess = "open" | "unknown" | "refused";

const savedAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): SavedAccess => {
    if (!get(keptEnvironmentsAtom(environmentId)).saved) return "open";
    if (embedConnectionRefused(get(connectionAtom(environmentId)))) return "refused";
    const access = get(keptViewAccessAtom(environmentId));
    return access === null ? "unknown" : access.refused ? "refused" : "open";
  }).pipe(Atom.withLabel(`web-embed-saved-access:${environmentId}`)),
);
const OPEN_ACCESS_ATOM = Atom.make((): SavedAccess => "open").pipe(
  Atom.withLabel("web-embed-saved-access:none"),
);

function useSavedAccess(environmentId: EnvironmentId | null): SavedAccess {
  return useAtomValue(environmentId === null ? OPEN_ACCESS_ATOM : savedAccessAtom(environmentId));
}

export function useEmbedSavedHidden(environmentId: EnvironmentId | null): boolean {
  return useSavedAccess(environmentId) !== "open";
}

function forgetEnvironmentThreads(environmentId: EnvironmentId): void {
  for (const atom of environmentThreads.environmentAtoms(environmentId)) {
    appAtomRegistry.refresh(atom);
  }
}

export function useEmbedKeptViewUpkeep(
  authenticated: boolean,
  threadRef: ScopedThreadRef | null,
): boolean {
  const environmentId = threadRef?.environmentId ?? null;
  const liveEnvironmentId = useLiveConfig(authenticated ? environmentId : null)?.environment
    .environmentId;
  const connection = useAtomValue(
    environmentId === null ? NO_CONNECTION_ATOM : connectionAtom(environmentId),
  );
  const kept = useAtomValue(
    environmentId === null ? NO_KEPT_ENVIRONMENTS_ATOM : keptEnvironmentsAtom(environmentId),
  );
  const saved = kept.saved;
  const savedRefused = useSavedAccess(saved ? environmentId : null) === "refused";
  const [refusedSession, setRefusedSession] = useState(false);
  const connected = connection.phase === "connected";
  const signedOut = refusedSession && !connected && !saved;
  const refused = embedConnectionRefused(connection);
  const wasConnected = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops every thread snapshot this frame holds for a saved environment once any frame's pairing is refused
  useEffect(() => {
    if (savedRefused && environmentId !== null) forgetEnvironmentThreads(environmentId);
  }, [savedRefused, environmentId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the thread's own server whether this page is still signed in when its socket drops or is refused, and wipes its kept views in IndexedDB when it is not
  useEffect(() => {
    if (!authenticated || environmentId === null) return;
    if (connected) {
      wasConnected.current = true;
      reopenKeptViews();
      return;
    }
    if (saved) {
      if (!refused) return;
      forgetEnvironmentThreads(environmentId);
      const generation = appAtomRegistry.get(keptViewAccessAtom(environmentId))?.generation;
      void (
        generation === undefined
          ? loadKeptViewAccess(environmentId).then((access) =>
              refuseKeptViews(environmentId, access.generation),
            )
          : refuseKeptViews(environmentId, generation)
      ).catch(() => undefined);
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
  }, [authenticated, connected, refused, saved, environmentId]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops every kept view in IndexedDB once the server says this frame is signed out or its pairing is gone
  useEffect(() => {
    if (!authenticated) void wipeKeptViews().catch(() => undefined);
  }, [authenticated]);
  const keep =
    liveEnvironmentId === undefined || kept.keep === null
      ? null
      : `${kept.keep}\n${liveEnvironmentId}`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops kept views of environments this page no longer saves once the live server names its own
  useEffect(() => {
    if (keep !== null) void retainKeptViewsOf(new Set(keep.split("\n"))).catch(() => undefined);
  }, [keep]);
  return authenticated && !signedOut;
}
