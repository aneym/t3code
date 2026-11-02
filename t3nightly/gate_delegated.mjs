import { writeFileSync, readFileSync, existsSync } from "node:fs";

export function delegatedDrain({ session, opts, Effect, Stream, applyEvent, cli }) {
  return Effect.gen(function* () {
    const path = opts.evidence;
    const proof = opts.phase === "before" ? { check: "delegated-child-drain", checks: [], observations: [] } : JSON.parse(readFileSync(path, "utf8"));
    const states = new Map();
    const persist = () => writeFileSync(path, JSON.stringify(proof, null, 2) + "\n");
    const mark = (name, ok, detail) => {
      proof.checks.push({ name, ok, at: new Date().toISOString(), ...detail });
      persist();
    };
    const subscribe = (threadId) => session.client["orchestration.subscribeThread"]({ threadId }).pipe(
      Stream.runForEach(item => Effect.sync(() => {
        const p = item.kind === "snapshot" ? item.projection : applyEvent(states.get(threadId), item.event);
        states.set(threadId, p);
        proof.observations.push({ at: new Date().toISOString(), threadId, runs: p.runs, tasks: p.subagents });
        persist();
      })), Effect.forkScoped);
    const wait = (label, predicate) => Effect.promise(async () => {
      const deadline = Date.now() + 60000;
      while (!predicate()) {
        if (Date.now() > deadline) { mark(label, false, {}); throw new Error(`waiting for ${label}`); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
    const open = task => task != null && ["pending", "running", "working", "waiting"].includes(task.status) && task.result == null;
    const agentPath = `${opts.home}/runtime/drain-replay/`;
    if (opts.phase === "before") {
      proof.parent = yield* cli("start", "--provider", "drainReplay", "--model", "showcase", opts.project, "DRAIN_PARENT");
      yield* subscribe(proof.parent.threadId);
      const parent = () => states.get(proof.parent.threadId);
      yield* wait("real-mcp-delegation", () => parent()?.subagents.some(t => t.childThreadId));
      proof.task = parent().subagents.find(t => t.childThreadId);
      yield* subscribe(proof.task.childThreadId);
      const child = () => states.get(proof.task.childThreadId);
      yield* wait("child-held", () => child()?.runs.some(r => r.status === "running") && existsSync(`${agentPath}observations.ndjson`) && readFileSync(`${agentPath}observations.ndjson`, "utf8").includes("child-hold-entered"));
      proof.child = child().runs.find(r => r.status === "running");
      writeFileSync(`${agentPath}parent-release`, "release\n");
      yield* wait("parent-first-run-completed", () => parent().runs.some(r => r.id === proof.parent.runId && r.status === "completed"));
      const ok = open(parent().subagents.find(t => t.id === proof.task.id));
      mark("before-drain", ok, { parent: parent().subagents, childRuns: child().runs, realMcpDelegation: true });
      if (!ok) throw new Error("parent task was not open before drain");
    } else {
      yield* subscribe(proof.parent.threadId);
      yield* subscribe(proof.task.childThreadId);
      const parent = () => states.get(proof.parent.threadId);
      const child = () => states.get(proof.task.childThreadId);
      yield* wait("restart-projections", () => parent() && child());
      const task = parent().subagents.find(t => t.id === proof.task.id);
      mark("after-restart", open(task), { task, childRuns: child().runs, sameTaskId: task?.id === proof.task.id });
      if (!open(task)) { proof.ok = false; persist(); return { check: proof.check, evidence: path, passed: proof.ok ?? true }; }
      yield* wait("child-resumed", () => child().runs.some(r => r.status === "running"));
      mark("child-resumed", true, { sameTaskId: true, runs: child().runs });
      writeFileSync(`${agentPath}release`, "release\n");
      yield* wait("child-completed", () => child().runs.some(r => r.status === "completed"));
      mark("child-completed", true, { runs: child().runs });
      yield* wait("parent-completion-delivered", () => parent().subagents.find(t => t.id === proof.task.id)?.result != null && parent().runs.some(r => r.ordinal > 1 && r.status === "completed") && parent().messages.some(m => m.role === "assistant" && m.text.includes("PARENT_RECEIVED_CHILD_FINISHED")));
      mark("parent-completion-delivered", true, { runs: parent().runs, tasks: parent().subagents, messages: parent().messages });
      proof.agentObservations = readFileSync(`${agentPath}observations.ndjson`, "utf8").trim().split("\n").map(JSON.parse);
      proof.ok = proof.checks.every(c => c.ok);
      persist();
    }
    return { check: proof.check, evidence: path, passed: proof.ok ?? true };
  });
}
