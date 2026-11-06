const listeners = new Set<(tabId: string, webContentsId: number) => void>();

export function onDesktopTabRegistered(
  listener: (tabId: string, webContentsId: number) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function desktopTabRegistered(tabId: string, webContentsId: number): void {
  for (const listener of listeners) listener(tabId, webContentsId);
}
