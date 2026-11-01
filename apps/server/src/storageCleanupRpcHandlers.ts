import { WS_METHODS } from "@t3tools/contracts";
import type * as StorageCleanup from "./storageCleanup.ts";

export const makeStorageCleanupRpcHandlers = (
  service: StorageCleanup.StorageCleanup["Service"],
) => ({
  [WS_METHODS.serverRunStorageCleanup]: () => service.runNow,
  [WS_METHODS.serverGetStorageCleanupReport]: () => service.latestReport,
  [WS_METHODS.serverSubscribeStorageCleanupReport]: () => service.reports,
});
