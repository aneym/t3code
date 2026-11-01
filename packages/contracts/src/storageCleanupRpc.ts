import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { ServerSettingsError, StorageCleanupReport } from "./settings.ts";

export const STORAGE_CLEANUP_WS_METHODS = {
  serverRunStorageCleanup: "server.runStorageCleanup",
  serverGetStorageCleanupReport: "server.getStorageCleanupReport",
  serverSubscribeStorageCleanupReport: "server.subscribeStorageCleanupReport",
} as const;

export const StorageCleanupRpcs = [
  Rpc.make(STORAGE_CLEANUP_WS_METHODS.serverRunStorageCleanup, {
    payload: Schema.Struct({}),
    success: StorageCleanupReport,
    error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(STORAGE_CLEANUP_WS_METHODS.serverGetStorageCleanupReport, {
    payload: Schema.Struct({}),
    success: Schema.NullOr(StorageCleanupReport),
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(STORAGE_CLEANUP_WS_METHODS.serverSubscribeStorageCleanupReport, {
    payload: Schema.Struct({}),
    success: Schema.NullOr(StorageCleanupReport),
    stream: true,
    error: EnvironmentAuthorizationError,
  }),
] as const;
