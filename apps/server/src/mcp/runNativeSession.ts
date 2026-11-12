import {
  ProviderDriverKind,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";

const SESSION_DRIVERS = new Set([
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
]);

export function runNativeSessionId(
  run: Pick<OrchestrationV2Run, "providerThreadId">,
  providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
): string | null {
  const providerThread = providerThreads.find((thread) => thread.id === run.providerThreadId);
  if (providerThread === undefined || !SESSION_DRIVERS.has(providerThread.driver)) return null;
  return providerThread.nativeThreadRef?.nativeId ?? null;
}
