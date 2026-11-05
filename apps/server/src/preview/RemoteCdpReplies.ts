const readId = (message: string): unknown => {
  try {
    const value: unknown = JSON.parse(message);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as { readonly id?: unknown }).id
      : null;
  } catch {
    return null;
  }
};

export const make = () => {
  const pending = new Map<object, Map<string, Set<number>>>();
  return {
    sent: (source: object, key: string, message: string) => {
      const id = readId(message);
      if (typeof id !== "number") return;
      const tabs = pending.get(source) ?? new Map<string, Set<number>>();
      pending.set(source, tabs);
      const ids = tabs.get(key) ?? new Set<number>();
      tabs.set(key, ids);
      ids.add(id);
    },
    admits: (source: object, key: string, message: string) => {
      const id = readId(message);
      if (id === undefined) return true;
      return typeof id === "number" && pending.get(source)?.get(key)?.delete(id) === true;
    },
    clear: (key: string) => {
      for (const tabs of pending.values()) tabs.delete(key);
    },
    drop: (source: object) => {
      pending.delete(source);
    },
  };
};
