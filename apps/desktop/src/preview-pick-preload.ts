import { ipcRenderer } from "electron";

import {
  ONE_TIME_CODE_FIELD_CHANNEL,
  PASSKEY_BRIDGE_ARGUMENT,
  PASSKEY_FALLBACK_ARGUMENT,
} from "./preview/GuestProtocol.ts";
import { installOneTimeCodeWatch } from "./preview/OneTimeCodeWatch.ts";
import { installPasskeyBridge } from "./preview/PasskeyBridge.ts";
import { installPasskeyFallback } from "./preview/PasskeyFallbackShim.ts";
import "./preview/PickPreload.ts";

// Electron hands webPreferences.additionalArguments to sandboxed preloads in process.argv.
if (process.argv.includes(PASSKEY_BRIDGE_ARGUMENT)) {
  installPasskeyBridge((channel, publicKey) => ipcRenderer.invoke(channel, publicKey));
} else if (process.argv.includes(PASSKEY_FALLBACK_ARGUMENT)) {
  installPasskeyFallback((channel, kind) => ipcRenderer.invoke(channel, kind));
}
installOneTimeCodeWatch((focused) => ipcRenderer.send(ONE_TIME_CODE_FIELD_CHANNEL, focused));
