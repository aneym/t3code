import { describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

const automationState = vi.hoisted(() => ({
  connectedIds: ["environment-test"],
  query: null as unknown,
}));

vi.mock("../state/environments", () => ({
  useConnectedEnvironmentIds: () => automationState.connectedIds,
}));
vi.mock("../state/environmentAtomList", () => ({
  environmentAtomList: () => () => "scheduled-tasks",
  environmentIdsKey: (ids: readonly string[]) => ids.join("\\n"),
}));
vi.mock("../state/server", () => ({
  serverEnvironment: { scheduledTasksLive: () => "scheduled-tasks" },
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original()),
  useAtomValue: () => [automationState.query],
}));

import { render } from "../../test/render";
import { useAutomationThreadKeys } from "../hooks/useAutomations";
import { useSnoozeWakeClock } from "./Sidebar.logic";

function AutomationKeys() {
  const keys = useAutomationThreadKeys();
  return <output>{[...keys].join(",")}</output>;
}

const MOUNTED_AT_MS = Date.parse("2026-10-24T08:00:00.000Z");

function WakeClock(props: { readonly threads: ReadonlyArray<{ readonly snoozedUntil: string }> }) {
  return <output>{useSnoozeWakeClock(props.threads)}</output>;
}

describe("useAutomationThreadKeys", () => {
  it("retains bound threads while the task source disconnects or fails", async () => {
    automationState.connectedIds = ["environment-test"];
    automationState.query = AsyncResult.success({ tasks: [{ threadId: "thread-automation" }] });
    await using screen = await render(<AutomationKeys />, { router: false });
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("environment-test:thread-automation");

    automationState.query = AsyncResult.failure(Cause.fail(new Error("request failed")));
    await screen.rerender(<AutomationKeys />);
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("environment-test:thread-automation");

    automationState.connectedIds = [];
    automationState.query = AsyncResult.failure(Cause.fail(new Error("disconnected")));
    await screen.rerender(<AutomationKeys />);

    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("environment-test:thread-automation");
  });
});

describe("useSnoozeWakeClock", () => {
  it("settles in one step when many distinct wakes passed during a sleep", async () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(MOUNTED_AT_MS);
    // More distinct wakes than React's 25 render-phase re-render limit.
    const threads = Array.from({ length: 40 }, (_, index) => ({
      snoozedUntil: new Date(MOUNTED_AT_MS + 1 + index * 60_000).toISOString(),
    }));
    await using screen = await render(<WakeClock threads={threads} />, {
      // A bare hook host; nothing here links or navigates.
      router: false,
    });
    await expect.element(screen.getByRole("status")).toHaveTextContent(String(MOUNTED_AT_MS));

    // The machine resumes after every wake has passed; the first wake's timer fires late.
    const resumedAtMs = MOUNTED_AT_MS + 24 * 60 * 60_000;
    now.mockReturnValue(resumedAtMs);

    // The clock lands on the last elapsed wake, so every woken thread has left the shelf.
    const lastWakeMs = MOUNTED_AT_MS + 1 + 39 * 60_000;
    await expect.element(screen.getByRole("status")).toHaveTextContent(String(lastWakeMs));
  });
});
