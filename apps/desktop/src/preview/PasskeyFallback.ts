import type { WebContents } from "electron";
import { BrowserWindow, dialog, shell } from "electron";

import { PASSKEY_FALLBACK_CHANNEL } from "./GuestProtocol.ts";

type FallbackChoice = "browser" | "native" | "cancel";

const CHOICES: ReadonlyArray<FallbackChoice> = ["browser", "native", "cancel"];

const handOffUrl = (guest: WebContents) => {
  const url = URL.parse(guest.getURL());
  return url && (url.protocol === "https:" || url.protocol === "http:") ? url.href : undefined;
};

export const attachPasskeyFallback = (guest: WebContents) => {
  let asking = false;
  guest.ipc.removeHandler(PASSKEY_FALLBACK_CHANNEL);
  guest.ipc.handle(PASSKEY_FALLBACK_CHANNEL, async (event): Promise<FallbackChoice> => {
    if (event.senderFrame !== guest.mainFrame || asking || !guest.isFocused()) return "cancel";
    const host = guest.hostWebContents
      ? BrowserWindow.fromWebContents(guest.hostWebContents)
      : null;
    if (!host || host.isDestroyed()) return "cancel";
    const url = handOffUrl(guest);
    asking = true;
    try {
      const { response } = await dialog.showMessageBox(host, {
        type: "info",
        message: "Passkeys need your system browser",
        detail:
          "This build of T3 Code is not signed with Apple's browser passkey entitlement, so iCloud Keychain, Touch ID and phone passkeys cannot answer here. Continue this sign-in in your default browser, or try a USB security key.",
        buttons: ["Open in Browser", "Try Security Key", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      const choice = CHOICES[response] ?? "cancel";
      if (choice === "browser" && url) await shell.openExternal(url);
      return choice === "browser" && !url ? "cancel" : choice;
    } finally {
      asking = false;
    }
  });
  return () => guest.ipc.removeHandler(PASSKEY_FALLBACK_CHANNEL);
};
