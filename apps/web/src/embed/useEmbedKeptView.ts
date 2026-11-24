import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type ScopedThreadRef, type ServerConfig } from "@t3tools/contracts";
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

const ACCESS_RETRY_MS = 2000;

const keptViewAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): KeptViewAccess | null => {
    let live = true;
    let latest = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      clearTimeout(retry);
      const sequence = ++latest;
      void loadKeptViewAccess(environmentId).then(
        (access) => {
          if (live && sequence === latest) get.setSelf(access);
        },
        () => {
          if (!live || sequence !== latest) return;
          get.setSelf(null);
          retry = setTimeout(read, ACCESS_RETRY_MS);
        },
      );
    };
    const stop = onKeptViewAccessChange((changed) => {
      if (changed !== environmentId) return;
      latest += 1;
      if (get.registry.get(keptEnvironmentsAtom(environmentId)).saved) {
        get.registry.set(environmentThreads.suspendedAtom(environmentId), true);
      }
      get.setSelf(null);
      read();
    });
    get.addFinalizer(() => {
      live = false;
      clearTimeout(retry);
      stop();
    });
    read();
    return null;
  }).pipe(Atom.withLabel(`web-embed-kept-view-access:${environmentId}`)),
);

type SavedAccess = "open" | "unknown" | "refused";

export const savedAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): SavedAccess => {
    if (!get(keptEnvironmentsAtom(environmentId)).saved) return "open";
    if (embedConnectionRefused(get(connectionAtom(environmentId)))) return "refused";
    const access = get(keptViewAccessAtom(environmentId));
    if (access === null) return "unknown";
    return access.refused || !access.current ? "refused" : "open";
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

const savedEnvironmentIdsAtom = Atom.make((get) =>
  [...get(environmentCatalog.catalogValueAtom).entries.values()]
    .filter((entry) => entry.target._tag !== "PrimaryConnectionTarget")
    .map((entry) => entry.target.environmentId)
    .toSorted()
    .join("\n"),
).pipe(Atom.withLabel("web-embed-saved-environment-ids"));

export function useEmbedSavedEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const joined = useAtomValue(savedEnvironmentIdsAtom);
  return joined === "" ? [] : joined.split("\n").map((id) => EnvironmentId.make(id));
}

export function useEmbedSavedEnvironmentGuard(environmentId: EnvironmentId): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps thread subscriptions of a saved environment stopped while its access is unread, refused or bound to another pairing, and reopens them after each fresh read; the marker event itself suspends them first
  useEffect(
    () =>
      appAtomRegistry.subscribe(
        savedAccessAtom(environmentId),
        (access) =>
          appAtomRegistry.set(environmentThreads.suspendedAtom(environmentId), access !== "open"),
        { immediate: true },
      ),
    [environmentId],
  );
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
  const [refusedSession, setRefusedSession] = useState(false);
  const connected = connection.phase === "connected";
  const signedOut = refusedSession && !connected && !saved;
  const refused = embedConnectionRefused(connection);
  const wasConnected = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the thread's own server whether this page is still signed in when its socket drops or is refused, and wipes its kept views in IndexedDB when it is not
  useEffect(() => {
    if (!authenticated || environmentId === null) return;
    if (connected) {
      wasConnected.current = true;
      reopenKeptViews();
      return;
    }
    if (saved) return;
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
