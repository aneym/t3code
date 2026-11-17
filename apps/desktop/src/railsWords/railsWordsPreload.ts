import type { DesktopRailsWordsBridge, DesktopRailsWordsState } from "@t3tools/contracts";
import { ipcRenderer } from "electron";

import * as IpcChannels from "../ipc/channels.ts";

export const railsWordsBridge: DesktopRailsWordsBridge = {
  getState: () => ipcRenderer.invoke(IpcChannels.RAILS_WORDS_GET_STATE_CHANNEL),
  onState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state === "object" && state !== null) listener(state as DesktopRailsWordsState);
    };
    ipcRenderer.on(IpcChannels.RAILS_WORDS_STATE_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(IpcChannels.RAILS_WORDS_STATE_CHANNEL, wrapped);
  },
  said: (input) => {
    ipcRenderer.invoke(IpcChannels.RAILS_WORDS_SAID_CHANNEL, input).catch(() => undefined);
  },
  disconnect: () => ipcRenderer.invoke(IpcChannels.RAILS_WORDS_DISCONNECT_CHANNEL),
};
