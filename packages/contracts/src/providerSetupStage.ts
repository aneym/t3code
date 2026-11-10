import type { ProviderAuthState, ProviderInstallState } from "./providerSetup.ts";
import type { ServerProvider } from "./server.ts";

export type ProviderSetupStage =
  | {
      readonly stage: "installing";
      readonly phase: "downloading" | "extracting" | "verifying";
      readonly downloadedBytes: number;
      readonly totalBytes: number | null;
    }
  | {
      readonly stage: "failed";
      readonly step: "install" | "signIn" | "provider";
      readonly reason: string;
    }
  | { readonly stage: "signingIn" }
  | { readonly stage: "notInstalled" }
  | { readonly stage: "ready" }
  | { readonly stage: "signedOut" };

export function providerSetupStage(input: {
  readonly provider: Pick<ServerProvider, "installed" | "status" | "auth" | "message">;
  readonly install: ProviderInstallState | null;
  readonly auth: ProviderAuthState | null;
}): ProviderSetupStage {
  const { provider, install, auth } = input;
  if (
    install?.phase === "downloading" ||
    install?.phase === "extracting" ||
    install?.phase === "verifying"
  ) {
    return {
      stage: "installing",
      phase: install.phase,
      downloadedBytes: install.downloadedBytes,
      totalBytes: install.totalBytes,
    };
  }
  if (install?.phase === "failed" && !provider.installed) {
    return { stage: "failed", step: "install", reason: install.message ?? "Install failed." };
  }
  if (auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying") {
    return { stage: "signingIn" };
  }
  if (auth?.phase === "failed" && provider.auth.status !== "authenticated") {
    return { stage: "failed", step: "signIn", reason: auth.message ?? "Sign-in failed." };
  }
  if (!provider.installed) return { stage: "notInstalled" };
  if (provider.auth.status === "authenticated") return { stage: "ready" };
  if (provider.auth.status === "unauthenticated") return { stage: "signedOut" };
  if (provider.status === "ready") return { stage: "ready" };
  return {
    stage: "failed",
    step: "provider",
    reason: provider.message ?? "This provider is not available.",
  };
}
