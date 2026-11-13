import type { DesktopUpdateActionResult } from "./ipc.ts";

export type DesktopInstallVersion = (version: string) => Promise<DesktopUpdateActionResult>;

declare module "./ipc.ts" {
  interface DesktopBridge {
    installDesktopVersion: DesktopInstallVersion;
  }
}
