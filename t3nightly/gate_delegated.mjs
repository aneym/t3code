import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function delegatedDrain({ session, opts, Effect, Stream, applyEvent, cli }) {
  return Effect.gen(function* () {
    const observations = [];
    const states = new Map();
    const listeners = new Set();
    const fail = (message) => {
      console.error(JSON.stringify({ check: "delegated-child-drain", error: message, observations }));
      return new Error(message);
    };
    const subscribe = (threadId) => session.client["orchestration.subscribeThread"]({ threadId }).pipe(
      Stream.runForEach(item => Effect.sync(() => {
        const p = item.kind === "snapshot" ? item.projection : applyEvent(states.get(threadId), item.event);
        states.set(threadId, p);
        observations.push({ threadId, runs: p.runs.map(({id, status}) => ({id, status})), tasks: p.subagents.map(({id, status, childThreadId, completionDelivery}) => ({id, status, childThreadId, completionDelivery})) });
        for (const check of [...listeners]) check();
      })), Effect.forkScoped);
    const wait = (label, predicate) => Effect.callback(resume => {
      let done = false;
      const check = () => { if (!done && predicate()) { done = true; listeners.delete(check); resume(Effect.void); } };
      listeners.add(check); check();
      const timer = setInterval(check, 100);
      return Effect.sync(() => { clearInterval(timer); listeners.delete(check); });
    }).pipe(Effect.timeout("35 seconds"), Effect.catchCause(() => Effect.fail(fail(`fixture failed waiting for ${label}`))));
    const parent = yield* cli("start", "--provider", "drainReplay", "--model", "showcase", opts.project, "DRAIN_PARENT");
    yield* subscribe(parent.threadId);
    const parentState = () => states.get(parent.threadId);
    yield* wait("real delegated task and waiting parent", () => parentState()?.subagents.some(t => t.childThreadId));
    const task = parentState().subagents.find(t => t.childThreadId);
    yield* subscribe(task.childThreadId);
    const childState = () => states.get(task.childThreadId);
    yield* wait("child hold", () => childState()?.runs.some(r => r.status === "running") && existsSync(`${opts.home}/runtime/drain-replay/observations.ndjson`) && readFileSync(`${opts.home}/runtime/drain-replay/observations.ndjson`, "utf8").includes("child-hold-entered"));
    const child = childState().runs.find(r => r.status === "running");
    const parentWaitingBeforeDrain = parentState().runs.find(r => r.id === parent.runId)?.status === "waiting";
    observations.push({milestone: "before-drain", parentWaiting: parentWaitingBeforeDrain, childRunning: true, realMcpDelegation: true});
    const epoch = randomUUID();
    let drain;
    try {
      ({ drain } = yield* session.client["server.prepareRestart"]({epoch, drainTimeoutMs: 120000}));
      const parentWaiting = parentState().runs.find(r => r.id === parent.runId)?.status === "waiting";
      const taskNotCancelled = !["cancelled", "failed", "interrupted"].includes(parentState().subagents.find(t => t.id === task.id)?.status);
      const childContinues = childState().runs.find(r => r.id === child.id)?.status === "running";
      observations.push({ milestone: "after-drain-before-release", parentWaiting, taskNotCancelled, childContinues, drain });
      writeFileSync(`${opts.home}/runtime/drain-replay/parent-release`, "release\n");
      writeFileSync(`${opts.home}/runtime/drain-replay/release`, "release\n");
      if (!parentWaitingBeforeDrain) throw fail("fixture: parent did not enter waiting before drain; product verdict unavailable");
      if (!parentWaiting || !taskNotCancelled || !childContinues) throw fail("product: drain cut delegated work or cancelled the waiting parent task");
    } finally {
      yield* session.client["server.abortRestart"]({epoch});
    }
    yield* wait("same child run completed", () => childState().runs.find(r => r.id === child.id)?.status === "completed");
    yield* wait("parent received completion", () => parentState().messages.some(m => m.role === "assistant" && m.text.includes("PARENT_RECEIVED_CHILD_FINISHED")));
    const agentObservations = readFileSync(`${opts.home}/runtime/drain-replay/observations.ndjson`, "utf8").trim().split("\n").map(JSON.parse);
    return {check: "delegated-child-drain", parentThreadId: parent.threadId, parentRunId: parent.runId, taskId: task.id, childThreadId: task.childThreadId, childRunId: child.id, parentWaiting: true, taskNotCancelled: true, sameChildRunCompleted: true, parentReceivedCompletion: true, drain, observations, agentObservations};
  });
}
