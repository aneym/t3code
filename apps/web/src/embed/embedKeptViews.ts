const DATABASE_NAME = "t3code:embed-kept-views";
const DATABASE_VERSION = 1;
const VIEW_STORE = "view";
const META_STORE = "meta";
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

let opening: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      for (const name of [VIEW_STORE, META_STORE]) {
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
  body: (view: IDBObjectStore, meta: IDBObjectStore) => () => A,
): Promise<A> {
  const begin = async () => {
    const database = await openDatabase();
    return database.transaction([VIEW_STORE, META_STORE], mode);
  };
  const transaction = await begin().catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
    opening = null;
    return begin();
  });
  return new Promise<A>((resolve, reject) => {
    const result = body(transaction.objectStore(VIEW_STORE), transaction.objectStore(META_STORE));
    transaction.addEventListener("complete", () => resolve(result()));
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("A kept view write was aborted.")),
    );
  });
}

function deleteEntries(view: IDBObjectStore, meta: IDBObjectStore, metas: Iterable<KeptViewMeta>) {
  for (const entry of metas) {
    const key = keyOf(entry.environmentId, entry.threadId);
    view.delete(key);
    meta.delete(key);
  }
}

export function loadKeptView(environmentId: string, threadId: string): Promise<string | undefined> {
  return transact("readonly", (view) => {
    const request = view.get(keyOf(environmentId, threadId));
    return () => (typeof request.result === "string" ? request.result : undefined);
  });
}

export function saveKeptView(
  environmentId: string,
  threadId: string,
  payload: string,
  now = Date.now(),
): Promise<void> {
  return transact("readwrite", (view, meta) => {
    const key = keyOf(environmentId, threadId);
    const existing = meta.get(key);
    existing.addEventListener("success", () => {
      const previous = existing.result as KeptViewMeta | undefined;
      view.put(payload, key);
      meta.put(
        { environmentId, threadId, length: payload.length, shownAt: previous?.shownAt ?? now },
        key,
      );
      const all = meta.getAll();
      all.addEventListener("success", () =>
        deleteEntries(view, meta, pickKeptViewEvictions(all.result as KeptViewMeta[])),
      );
    });
    return () => undefined;
  });
}

export function removeKeptView(environmentId: string, threadId: string): Promise<void> {
  return transact("readwrite", (view, meta) => {
    const key = keyOf(environmentId, threadId);
    view.delete(key);
    meta.delete(key);
    return () => undefined;
  });
}

export function clearKeptViewsFor(environmentId: string): Promise<void> {
  return transact("readwrite", (view, meta) => {
    view.delete(environmentRange(environmentId));
    meta.delete(environmentRange(environmentId));
    return () => undefined;
  });
}

export function retainKeptViewsOf(environmentId: string): Promise<void> {
  return transact("readwrite", (view, meta) => {
    const all = meta.getAll();
    all.addEventListener("success", () =>
      deleteEntries(
        view,
        meta,
        (all.result as KeptViewMeta[]).filter((entry) => entry.environmentId !== environmentId),
      ),
    );
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

export function markKeptViewShown(
  environmentId: string,
  threadId: string,
  now = Date.now(),
): Promise<void> {
  return transact("readwrite", (_view, meta) => {
    const key = keyOf(environmentId, threadId);
    const existing = meta.get(key);
    existing.addEventListener("success", () => {
      const previous = existing.result as KeptViewMeta | undefined;
      if (previous !== undefined && previous.shownAt < now) {
        meta.put({ ...previous, shownAt: now }, key);
      }
    });
    return () => undefined;
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
