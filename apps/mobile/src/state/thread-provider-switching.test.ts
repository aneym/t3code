import { ProviderInstanceId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadAllowsProviderSwitch } from "./thread-provider-switching";

const startedThread = {
  latestRun: { id: "run-1" },
  latestUserMessageAt: "2026-06-01T00:00:00.000Z",
  runtime: { status: "idle" },
} as never;

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-luna",
} satisfies OrchestrationV2ThreadProjection["thread"]["modelSelection"];

function projectionWithSession(supportsProviderSwitchingViaHandoff: boolean) {
  return {
    thread: { modelSelection, id: "thread", activeProviderThreadId: "provider-thread" },
    runs: [],
    providerThreads: [
      {
        id: "provider-thread",
        appThreadId: "thread",
        providerInstanceId: modelSelection.instanceId,
        providerSessionId: "provider-session",
      },
    ],
    providerSessions: [
      {
        id: "provider-session",
        providerInstanceId: modelSelection.instanceId,
        status: "running",
        capabilities: { sessions: { supportsProviderSwitchingViaHandoff } },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

describe("threadAllowsProviderSwitch", () => {
  it("keeps a started thread on its provider when the session cannot hand off", () => {
    expect(
      threadAllowsProviderSwitch({
        thread: startedThread,
        projection: projectionWithSession(false),
      }),
    ).toBe(false);
  });

  it("allows an imported thread to hand off before opening a provider session", () => {
    expect(
      threadAllowsProviderSwitch({
        thread: startedThread,
        projection: {
          thread: {
            modelSelection,
            id: "thread",
            activeProviderThreadId: null,
            historyOrigin: "v1_import",
          },
          runs: [],
          providerThreads: [],
          providerSessions: [],
        } as unknown as OrchestrationV2ThreadProjection,
      }),
    ).toBe(true);
  });

  it("keeps a preparing turn bound before its provider session appears", () => {
    expect(
      threadAllowsProviderSwitch({
        thread: startedThread,
        projection: {
          thread: {
            modelSelection,
            id: "thread",
            activeProviderThreadId: null,
            historyOrigin: "v1_import",
          },
          runs: [{ status: "preparing", providerThreadId: "provider-thread" }],
          providerThreads: [],
          providerSessions: [],
        } as unknown as OrchestrationV2ThreadProjection,
      }),
    ).toBe(false);
  });

  it("keeps a started thread bound until its projection resolves a session", () => {
    expect(threadAllowsProviderSwitch({ thread: startedThread, projection: null })).toBe(false);
  });
});
