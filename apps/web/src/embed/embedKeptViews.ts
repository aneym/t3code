const DATABASE_NAME = "t3code:embed-kept-views";
const DATABASE_VERSION = 2;
const VIEW_STORE = "view";
const META_STORE = "meta";
const ACCESS_STORE = "access";
const ACCESS_CHANNEL = "t3code:embed-kept-view-access";
const SHOWN_FLUSH_MS = 1000;

export const KEPT_VIEW_LIMITS = {
  maxLength: 40 * 1024 * 1024,
  maxEntries: 200,
  maxEntryLength: 256 * 1024,
} as const;

interface KeptViewMeta {
  readonly environmentId: string;
  readonly threadId: string;
  readonly length: number;
  readonly shownAt: number;
}

function pickKeptViewEvictions(metas: ReadonlyArray<KeptViewMeta>): ReadonlyArray<KeptViewMeta> {
  const newestFirst = [...metas].sort((a, b) => b.shownAt - a.shownAt);
  let length = 0;
  const cut = newestFirst.findIndex((meta, index) => {
    length += meta.length;
    return index >= KEPT_VIEW_LIMITS.maxEntries || length > KEPT_VIEW_LIMITS.maxLength;
  });
  return cut === -1 ? [] : newestFirst.slice(cut);
}

const keyOf = (environmentId: string, threadId: string): IDBValidKey => [environmentId, threadId];
const environmentRange = (environmentId: string) =>
  IDBKeyRange.bound([environmentId], [environmentId, []]);

export interface KeptViewAccess {
  readonly refused: boolean;
  readonly current: boolean;
}

interface StoredAccess {
  readonly generation: number;
  readonly credential: string | null;
  readonly refused: boolean;
  readonly refusedCredentials: ReadonlyArray<string>;
}

const REFUSED_CREDENTIALS_KEPT = 8;

const OPEN_ACCESS: StoredAccess = {
  generation: 0,
  credential: null,
  refused: false,
  refusedCredentials: [],
};

function storedAccess(value: unknown): StoredAccess {
  if (typeof value !== "object" || value === null) return OPEN_ACCESS;
  const record = value as Record<string, unknown>;
  const generation = typeof record.generation === "number" ? record.generation : 0;
  return {
    generation,
    credential: typeof record.credential === "string" ? record.credential : null,
    refused:
      typeof record.refused === "boolean"
        ? record.refused
        : typeof record.refusedGeneration === "number",
    refusedCredentials: Array.isArray(record.refusedCredentials)
      ? record.refusedCredentials.filter((each): each is string => typeof each === "string")
      : [],
  };
}

let opening: Promise<IDBDatabase> | null = null;
let sealed = false;
const frameGenerations = new Map<string, number>();
const pendingGrants = new Map<string, Promise<void>>();

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      for (const name of [VIEW_STORE, META_STORE, ACCESS_STORE]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    });
    request.addEventListener("success", () => {
      const database = request.result;
      const forget = () => {
        opening = null;
        database.close();
      };
      database.addEventListener("close", forget);
      database.addEventListener("versionchange", forget);
      resolve(database);
    });
    request.addEventListener("error", () => {
      opening = null;
      reject(request.error ?? new Error("Could not open the kept views."));
    });
  });
  return opening;
}

async function transact<A>(
  mode: IDBTransactionMode,
  body: (view: IDBObjectStore, meta: IDBObjectStore, access: IDBObjectStore) => () => A,
): Promise<A> {
  const begin = async () => {
    const database = await openDatabase();
    return database.transaction([VIEW_STORE, META_STORE, ACCESS_STORE], mode);
  };
  const transaction = await begin().catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
    opening = null;
    return begin();
  });
  return new Promise<A>((resolve, reject) => {
    const result = body(
      transaction.objectStore(VIEW_STORE),
      transaction.objectStore(META_STORE),
      transaction.objectStore(ACCESS_STORE),
    );
    transaction.addEventListener("complete", () => resolve(result()));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("A kept view write was aborted.")),
    );
  });
}

function readAccess(
  access: IDBObjectStore,
  environmentId: string,
  then: (stored: StoredAccess) => void,
): void {
  const request = access.get(environmentId);
  request.addEventListener("success", () => then(storedAccess(request.result)));
}

function announceAccess(environmentId: string): void {
  const channel = new BroadcastChannel(ACCESS_CHANNEL);
  channel.postMessage(environmentId);
  channel.close();
}

export function onKeptViewAccessChange(listener: (environmentId: string) => void): () => void {
  const channel = new BroadcastChannel(ACCESS_CHANNEL);
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") listener(event.data);
  });
  return () => channel.close();
}

export async function loadKeptViewAccess(environmentId: string): Promise<KeptViewAccess> {
  const stored = await transact("readonly", (_view, _meta, access) => {
    let read = OPEN_ACCESS;
    readAccess(access, environmentId, (each) => {
      read = each;
    });
    return () => read;
  });
  if (!frameGenerations.has(environmentId)) frameGenerations.set(environmentId, stored.generation);
  return {
    refused: stored.refused,
    current: frameGenerations.get(environmentId) === stored.generation,
  };
}

export async function refuseKeptViews(
  environmentId: string,
  credentialRevision: string,
): Promise<void> {
  await pendingGrants.get(environmentId)?.catch(() => undefined);
  await transact("readwrite", (view, meta, access) => {
    readAccess(access, environmentId, (stored) => {
      const refusedCredentials = [
        ...stored.refusedCredentials.filter((each) => each !== credentialRevision),
        credentialRevision,
      ].slice(-REFUSED_CREDENTIALS_KEPT);
      const current = stored.credential === null || stored.credential === credentialRevision;
      access.put(
        {
          ...stored,
          credential: current ? credentialRevision : stored.credential,
          refused: current ? true : stored.refused,
          refusedCredentials,
        } satisfies StoredAccess,
        environmentId,
      );
      if (!current) return;
      view.delete(environmentRange(environmentId));
      meta.delete(environmentRange(environmentId));
    });
    return () => undefined;
  });
  announceAccess(environmentId);
}

export function grantKeptViews(environmentId: string, credentialRevision: string): Promise<void> {
  const grant = transact("readwrite", (_view, _meta, access) => {
    let next = 0;
    readAccess(access, environmentId, (stored) => {
      next = stored.generation + 1;
      access.put(
        {
          generation: next,
          credential: credentialRevision,
          refused: stored.refusedCredentials.includes(credentialRevision),
          refusedCredentials: stored.refusedCredentials,
        } satisfies StoredAccess,
        environmentId,
      );
    });
    return () => next;
  }).then((generation) => {
    frameGenerations.set(environmentId, generation);
    announceAccess(environmentId);
  });
  pendingGrants.set(environmentId, grant);
  return grant.finally(() => {
    if (pendingGrants.get(environmentId) === grant) pendingGrants.delete(environmentId);
  });
}

function deleteEntries(view: IDBObjectStore, meta: IDBObjectStore, metas: Iterable<KeptViewMeta>) {
  for (const entry of metas) {
    const key = keyOf(entry.environmentId, entry.threadId);
    view.delete(key);
    meta.delete(key);
  }
}

function evictOwned(
  view: IDBObjectStore,
  meta: IDBObjectStore,
  access: IDBObjectStore,
  evictions: ReadonlyArray<KeptViewMeta>,
): void {
  for (const environmentId of new Set(evictions.map((entry) => entry.environmentId))) {
    const known = frameGenerations.get(environmentId);
    readAccess(access, environmentId, (stored) => {
      if (known !== undefined && stored.generation !== known) return;
      deleteEntries(
        view,
        meta,
        evictions.filter((entry) => entry.environmentId === environmentId),
      );
    });
  }
}

interface StoredView {
  readonly generation: number;
  readonly payload: string;
}

const viewGeneration = (stored: unknown): number | null =>
  typeof stored === "string"
    ? 0
    : typeof stored === "object" &&
        stored !== null &&
        "generation" in stored &&
        typeof stored.generation === "number"
      ? stored.generation
      : null;

const viewPayload = (stored: unknown): string | undefined =>
  typeof stored === "string"
    ? stored
    : typeof stored === "object" &&
        stored !== null &&
        "payload" in stored &&
        typeof stored.payload === "string"
      ? stored.payload
      : undefined;

function withFrameAccess(
  access: IDBObjectStore,
  environmentId: string,
  then: (generation: number) => void,
): () => void {
  const known = frameGenerations.get(environmentId);
  let seen: number | undefined;
  readAccess(access, environmentId, (stored) => {
    seen = stored.generation;
    const generation = known ?? stored.generation;
    if (sealed || stored.refused || stored.generation !== generation) return;
    then(generation);
  });
  return () => {
    if (seen !== undefined && !frameGenerations.has(environmentId)) {
      frameGenerations.set(environmentId, seen);
    }
  };
}

export function loadKeptView(environmentId: string, threadId: string): Promise<string | undefined> {
  return transact("readonly", (view, _meta, access) => {
    let result: string | undefined;
    const adopt = withFrameAccess(access, environmentId, (generation) => {
      const request = view.get(keyOf(environmentId, threadId));
      request.addEventListener("success", () => {
        if (viewGeneration(request.result) === generation) result = viewPayload(request.result);
      });
    });
    return () => {
      adopt();
      return result;
    };
  });
}

export function saveKeptView(
  environmentId: string,
  threadId: string,
  payload: string,
  now = Date.now(),
): Promise<void> {
  return transact("readwrite", (view, meta, access) => {
    const key = keyOf(environmentId, threadId);
    const adopt = withFrameAccess(access, environmentId, (generation) => {
      const existing = meta.get(key);
      existing.addEventListener("success", () => {
        const previous = existing.result as KeptViewMeta | undefined;
        view.put({ generation, payload } satisfies StoredView, key);
        meta.put(
          { environmentId, threadId, length: payload.length, shownAt: previous?.shownAt ?? now },
          key,
        );
        const all = meta.getAll();
        all.addEventListener("success", () =>
          evictOwned(view, meta, access, pickKeptViewEvictions(all.result as KeptViewMeta[])),
        );
      });
    });
    return adopt;
  });
}

export function removeKeptView(environmentId: string, threadId: string): Promise<void> {
  return transact("readwrite", (view, meta, access) => {
    const key = keyOf(environmentId, threadId);
    return withFrameAccess(access, environmentId, () => {
      view.delete(key);
      meta.delete(key);
    });
  });
}

export function clearKeptViewsFor(environmentId: string): Promise<void> {
  return transact("readwrite", (view, meta, access) =>
    withFrameAccess(access, environmentId, () => {
      view.delete(environmentRange(environmentId));
      meta.delete(environmentRange(environmentId));
    }),
  );
}

export function retainKeptViewsOf(environmentIds: ReadonlySet<string>): Promise<void> {
  return transact("readwrite", (view, meta, access) => {
    const all = meta.getAll();
    all.addEventListener("success", () => {
      const dropped = (all.result as KeptViewMeta[]).filter(
        (entry) => !environmentIds.has(entry.environmentId),
      );
      for (const environmentId of new Set(dropped.map((entry) => entry.environmentId))) {
        const known = frameGenerations.get(environmentId);
        readAccess(access, environmentId, (stored) => {
          if (known === undefined || stored.generation !== known) return;
          deleteEntries(
            view,
            meta,
            dropped.filter((entry) => entry.environmentId === environmentId),
          );
        });
      }
    });
    return () => undefined;
  });
}

export function forgetKeptViews(): Promise<void> {
  return transact("readwrite", (view, meta) => {
    view.clear();
    meta.clear();
    return () => undefined;
  });
}

export function wipeKeptViews(): Promise<void> {
  sealed = true;
  return forgetKeptViews();
}

export function reopenKeptViews(): void {
  sealed = false;
}

export function markKeptViewShown(
  environmentId: string,
  threadId: string,
  now = Date.now(),
): Promise<void> {
  return transact("readwrite", (_view, meta, access) => {
    const key = keyOf(environmentId, threadId);
    return withFrameAccess(access, environmentId, () => {
      const existing = meta.get(key);
      existing.addEventListener("success", () => {
        const previous = existing.result as KeptViewMeta | undefined;
        if (previous !== undefined && previous.shownAt < now) {
          meta.put({ ...previous, shownAt: now }, key);
        }
      });
    });
  });
}

const shown = new Map<string, { environmentId: string; threadId: string; at: number }>();
let flush: ReturnType<typeof setTimeout> | undefined;

export function noteKeptViewShown(environmentId: string, threadId: string): void {
  shown.set(JSON.stringify([environmentId, threadId]), {
    environmentId,
    threadId,
    at: Date.now(),
  });
  flush ??= setTimeout(() => {
    flush = undefined;
    const pending = [...shown.values()];
    shown.clear();
    for (const entry of pending) {
      void markKeptViewShown(entry.environmentId, entry.threadId, entry.at).catch(() => undefined);
    }
  }, SHOWN_FLUSH_MS);
}
