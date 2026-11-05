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
  const pending = new Map<string, Set<number>>();
  return {
    sent: (key: string, message: string) => {
      const id = readId(message);
      if (typeof id !== "number") return;
      const ids = pending.get(key) ?? new Set<number>();
      pending.set(key, ids);
      ids.add(id);
    },
    admits: (key: string, message: string) => {
      const id = readId(message);
      if (id === undefined) return true;
      return typeof id === "number" && pending.get(key)?.delete(id) === true;
    },
    clear: (key: string) => {
      pending.delete(key);
    },
  };
};
