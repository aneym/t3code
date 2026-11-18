export type EmbedWarmSet = {
  readonly show: (thread: string) => void;
  readonly warm: (threads: ReadonlyArray<string>) => void;
  readonly clear: () => void;
};

export function createEmbedWarmSet(
  limit: number,
  mount: (thread: string) => () => void,
): EmbedWarmSet {
  const kept = new Map<string, () => void>();
  let shown: string | null = null;
  const touch = (thread: string) => {
    const release = kept.get(thread) ?? mount(thread);
    kept.delete(thread);
    kept.set(thread, release);
  };
  const evict = () => {
    for (const [thread, release] of kept) {
      if (kept.size <= limit) return;
      if (thread === shown) continue;
      kept.delete(thread);
      release();
    }
  };
  return {
    show: (thread) => {
      shown = thread;
      touch(thread);
      evict();
    },
    warm: (threads) => {
      const room = shown === null ? limit : limit - 1;
      const wanted = threads.filter((thread) => thread !== shown).slice(0, room);
      for (const thread of wanted.toReversed()) touch(thread);
      evict();
    },
    clear: () => {
      for (const release of kept.values()) release();
      kept.clear();
      shown = null;
    },
  };
}
