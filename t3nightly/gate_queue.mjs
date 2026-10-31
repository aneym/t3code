import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execute = promisify(execFile);
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

export function queueDrain({ session, config, opts, Effect, Stream, applyEvent }) {
  return Effect.gen(function* () {
    const interrupted = opts.scenario === "interrupt";
    const recovering = opts.scenario === "recover";
    const markers = recovering ? JSON.parse(opts.markers) : [0, 1, 2].map((index) => `QD${randomUUID().replaceAll("-", "")}_${index}`);
    const batched = config?.settings?.batchQueuedMessages === true;
    const receipts = [];
    const observations = [];
    let restartObservation = null;
    let projection = null;
    const listeners = new Set();
    const redactText = (text) => text
      .replace(/(Pairing URL:\s+)\S+/gi, "$1REDACTED")
      .replace(/((?:token|ticket|access_token|wsTicket)=)[^&\s"]+/gi, "$1REDACTED")
      .replace(/(Bearer\s+)\S+/gi, "$1REDACTED");
    const evidence = () => ({
      scenario: opts.scenario,
      batchQueuedMessages: batched,
      expectedMarkers: markers,
      receipts,
      observations,
      restartObservation,
      assistantReplies: projection?.messages
        .filter((message) => message.role === "assistant" && message.text.trim())
        .slice(-20)
        .map(({ id, runId, text }) => ({ id, runId, text: redactText(text).slice(0, 500) })) ?? [],
      runs: projection?.runs.map(({ id, status, queueHeld }) => ({ id, status, queueHeld })) ?? [],
      activeRunIds: projection?.runs.filter((run) => !terminal.has(run.status) && run.status !== "queued").map((run) => run.id) ?? [],
    });
    const fail = (message) => {
      console.error(JSON.stringify({ queueDrainFailure: message, ...evidence() }));
      return Object.assign(new Error(message), { result: evidence() });
    };
    const cli = (...args) => Effect.promise(async () => {
      const { stdout } = await execute(opts.cli, ["thread", ...args, "--base-dir", opts.home, "--json"], {
        cwd: opts.project,
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(stdout);
    });
    const waitFor = (label, predicate) => Effect.callback((resume) => {
      const check = () => {
        try {
          if (projection && predicate(projection)) {
            listeners.delete(check);
            resume(Effect.succeed(projection));
          }
        } catch (error) {
          listeners.delete(check);
          resume(Effect.fail(error));
        }
      };
      listeners.add(check);
      check();
      return Effect.sync(() => listeners.delete(check));
    }).pipe(Effect.timeout(`${Number(opts.timeout ?? 180)} seconds`), Effect.catchCause((cause) => Effect.fail(fail(`failed waiting for ${label}: ${String(cause)}`))));
    const subscribe = (threadId) => session.client["orchestration.subscribeThread"]({ threadId }).pipe(
      Stream.runForEach((item) => Effect.sync(() => {
        if (item.kind === "snapshot") projection = item.projection;
        else if (item.kind === "event") projection = applyEvent(projection, item.event);
        if (!projection) return;
        const state = projection.runs.map(({ id, status, queueHeld }) => ({ id, status, queueHeld: queueHeld === true }));
        const last = observations.at(-1);
        if (!last || JSON.stringify(last.runs) !== JSON.stringify(state)) observations.push({ runs: state });
        for (const listener of [...listeners]) listener();
      })),
      Effect.forkScoped,
    );
    if (recovering) {
      const threadId = opts.thread;
      const queuedId = opts["queued-run"];
      yield* subscribe(threadId);
      yield* waitFor("recovered projection", () => true);
      const heldAfterRecovery = projection.runs.find((run) => run.id === queuedId)?.queueHeld === true;
      if (!heldAfterRecovery) {
        yield* waitFor("queued A to complete after recovery", (p) => p.runs.some((run) => run.id === queuedId && run.status === "completed"));
      }
      const sent = yield* cli("send", "--mode", "queue", threadId, `Reply with exactly ${markers[2]} and nothing else. Do not use tools.`);
      receipts.push(sent);
      yield* waitFor("message B persisted", (p) => p.runs.some((run) => run.id === sent.runId));
      const inheritedHold = projection.runs.find((run) => run.id === sent.runId)?.queueHeld === true;
      const aBeforeSend = projection.runs.find((run) => run.id === queuedId);
      const bAfterSend = projection.runs.find((run) => run.id === sent.runId);
      restartObservation = {
        aHeldAfterRecovery: heldAfterRecovery,
        bInheritedHold: inheritedHold,
        bBypassedHeldA: heldAfterRecovery && bAfterSend?.status !== "queued",
        aTerminalBeforeBStart: aBeforeSend?.status === "completed" && !aBeforeSend.queueHeld,
        bDelivery: sent.delivery,
      };
      if (inheritedHold) throw fail(`restart recovery left A held=${heldAfterRecovery}; later CLI message B inherited hold=true`);
      const final = yield* waitFor("message B to complete", (p) => p.runs.some((run) => run.id === sent.runId && terminal.has(run.status)));
      const bStatus = final.runs.find((run) => run.id === sent.runId)?.status;
      restartObservation.bFinalStatus = bStatus;
      if (heldAfterRecovery || bStatus !== "completed") throw fail(`restart recovery left A held=${heldAfterRecovery}; later CLI message B inherited hold=false, ended ${bStatus}`);
      if (!restartObservation.aTerminalBeforeBStart) throw fail("B started before A completed without a hold");
      for (const [id, marker] of [[queuedId, markers[1]], [sent.runId, markers[2]]]) {
        const replies = final.messages.filter((message) => message.runId === id && message.role === "assistant" && message.text.trim());
        if (replies.length !== 1 || replies[0].text.trim() !== marker) throw fail(`recovered run ${id} did not persist exactly one expected reply`);
      }
      if (final.runs.some((run) => run.queueHeld || !terminal.has(run.status))) throw fail("restart left held or pending work");
      return { ...evidence(), threadId, exactlyOnceReplies: 2 };
    }
    if (opts.scenario === "starting-send") {
      const first = yield* cli("start", "--provider", "claudeAgent", "--model", opts.model, opts.project, `Reply with exactly ${markers[0]} and nothing else. Do not use tools.`);
      if (!first.threadId || !first.runId) throw fail("thread start did not return thread and run ids");
      const starting = (p) => {
        const run = p.runs.find((item) => item.id === first.runId);
        return run?.status === "running" && !(p.attempts ?? []).some((attempt) => attempt.runId === first.runId && attempt.providerTurnId);
      };
      yield* subscribe(first.threadId);
      yield* waitFor("first run running before its provider turn", (p) => starting(p) || p.runs.some((run) => run.id === first.runId && terminal.has(run.status)) || (p.attempts ?? []).some((attempt) => attempt.runId === first.runId && attempt.providerTurnId));
      const openBefore = starting(projection);
      const order = { tick: 0, turnEnded: null, sent: null };
      const track = () => {
        order.tick += 1;
        if (order.turnEnded === null && !starting(projection)) order.turnEnded = order.tick;
        if (order.sent === null && projection.messages.some((message) => message.role === "user" && message.text.includes(markers[1]))) order.sent = order.tick;
      };
      listeners.add(track);
      track();
      const sent = yield* cli("send", "--mode", "auto", first.threadId, `Reply with exactly ${markers[1]} and nothing else. Do not use tools.`);
      receipts.push(first, sent);
      yield* waitFor("sent message persisted", () => order.sent !== null);
      listeners.delete(track);
      const missed = !openBefore || (order.turnEnded !== null && order.turnEnded < order.sent) || sent.delivery === "steered";
      const distinct = Boolean(sent.runId) && sent.runId !== first.runId;
      restartObservation = { openBefore, turnEndedTick: order.turnEnded, sentTick: order.sent, missed, delivery: sent.delivery };
      if (!missed && !distinct) throw fail("send into a starting run did not return a distinct run");
      if (!missed && sent.delivery !== "queued") throw fail(`auto send into a starting run was delivered ${sent.delivery} instead of queued behind it`);
      const expected = distinct ? [[first.runId, markers[0]], [sent.runId, markers[1]]] : [[first.runId, null]];
      const final = yield* waitFor("runs to settle", (p) =>
        expected.every(([id]) => p.runs.some((run) => run.id === id && terminal.has(run.status))) && p.runs.every((run) => terminal.has(run.status)),
      );
      for (const [id, marker] of expected) {
        const status = final.runs.find((run) => run.id === id)?.status;
        const replies = final.messages.filter((message) => message.runId === id && message.role === "assistant" && message.text.trim());
        if (status !== "completed" || (marker === null ? replies.length < 1 : replies.length !== 1 || replies[0].text.trim() !== marker)) throw fail(`run ${id} ended ${status} with ${replies.length} replies instead of one ${marker ?? "reply"}`);
      }
      if (final.runs.length !== expected.length || final.runs.some((run) => run.queueHeld)) throw fail("unexpected runs or held work remain");
      const inconclusive = missed ? `the send landed after the first run left its startup window (delivered ${sent.delivery}${sent.delivery === "steered" ? ", server had the turn active" : ""})` : undefined;
      return { ...evidence(), threadId: first.threadId, firstRun: first.runId, sentDelivery: sent.delivery, exactlyOnceReplies: distinct ? 2 : 0, inconclusive };
    }
    const started = yield* cli(
      "start", "--provider", "claudeAgent", "--model", opts.model, opts.project,
      `Run this exact bounded CPU checksum command with the Bash tool in the foreground, not as a background task: python3 -c "import hashlib; print(hashlib.pbkdf2_hmac('sha256', b'gate', b'gate', 120000000).hex()); print('${markers[0]}')". After it finishes reply with only ${markers[0]}. Do not run any other tools.`,
    );
    const threadId = started.threadId;
    const firstRun = started.runId;
    if (!threadId || !firstRun) throw fail("thread start did not return thread and run ids");
    yield* subscribe(threadId);
    yield* waitFor("foreground command to start", (p) => p.turnItems.some((item) =>
      item.runId === firstRun && item.type === "command_execution" && item.input.includes("pbkdf2_hmac") && !terminal.has(item.status),
    ));
    for (const marker of markers.slice(1, opts.scenario === "prepare-restart" ? 2 : 3)) {
      const sent = yield* cli("send", "--mode", "queue", threadId, `Reply with exactly ${marker} and nothing else. Do not use tools.`);
      receipts.push(sent);
      if (sent.delivery !== "queued" || sent.status !== "queued") throw fail("message was not queued during the active turn");
    }
    const queuedIds = receipts.map((receipt) => receipt.runId);
    if (new Set([firstRun, ...queuedIds]).size !== queuedIds.length + 1) throw fail("queue receipts reused a run id");
    yield* waitFor("both queued messages behind the active run", (p) =>
      p.runs.some((run) => run.id === firstRun && run.status === "running") && queuedIds.every((id) => p.runs.some((run) => run.id === id && run.status === "queued" && !run.queueHeld)),
    );
    if (opts.scenario === "prepare-restart") return { ...evidence(), threadId, firstRun, queuedRun: queuedIds[0], markers };
    if (interrupted) {
      yield* session.client["orchestration.dispatchCommand"]({
        type: "run.interrupt", commandId: randomUUID(), threadId, runId: firstRun,
      });
    }
    const final = yield* waitFor("automatic queue drain", (p) => {
      const queuedRuns = queuedIds.map((id) => p.runs.find((run) => run.id === id));
      const absorbed = batched ? queuedRuns[1] : undefined;
      const invalid = queuedRuns.some((run, index) =>
        run?.queueHeld || (run !== undefined && ["failed", "interrupted"].includes(run.status)) ||
        (!batched && run?.status === "cancelled") || (batched && index === 0 && run?.status === "cancelled"),
      );
      if (invalid) throw fail("queued work was held or terminated instead of automatically draining");
      const first = queuedRuns[0];
      if (absorbed?.status === "cancelled" && first?.status !== "completed") return false;
      if (!batched && queuedRuns[1]?.status !== "queued" && first?.status !== "completed") throw fail("queued runs started out of order");
      return p.runs.every((run) => terminal.has(run.status)) &&
        (batched
          ? first?.status === "completed" && absorbed?.status === "cancelled"
          : queuedIds.every((id) => p.runs.some((run) => run.id === id && run.status === "completed")));
    });
    const original = final.runs.find((run) => run.id === firstRun);
    if (original?.status !== (interrupted ? "interrupted" : "completed")) throw fail(`original run ended ${original?.status}`);
    if (final.runs.length !== 3 || final.runs.some((run) => run.queueHeld || !terminal.has(run.status))) throw fail("unexpected runs or pending work remain");
    const originalReplies = final.messages.filter((message) => message.runId === firstRun && message.role === "assistant" && message.text.trim());
    if (interrupted ? originalReplies.length !== 0 : originalReplies.length !== 1 || (!interrupted && originalReplies[0].text.trim() !== markers[0])) {
      throw fail(`original run did not persist the expected reply count and marker`);
    }
    const queuedTarget = queuedIds[0];
    const queuedReplies = final.messages.filter((message) => message.runId === queuedTarget && message.role === "assistant" && message.text.trim());
    if (batched) {
      const absorbed = final.runs.find((run) => run.id === queuedIds[1]);
      const queuedText = queuedReplies[0]?.text.trim() ?? "";
      const firstMarker = markers[1];
      const secondMarker = markers[2];
      if (absorbed?.status !== "cancelled" || queuedReplies.length !== 1 ||
          queuedText.indexOf(firstMarker) < 0 || queuedText.indexOf(secondMarker) < queuedText.indexOf(firstMarker)) {
        throw fail(`batched queued runs did not persist one ordered reply and cancel the absorbed run`);
      }
    } else {
      for (const id of queuedIds) {
        const marker = markers[[firstRun, ...queuedIds].indexOf(id)];
        const replies = final.messages.filter((message) => message.runId === id && message.role === "assistant" && message.text.trim());
        if (replies.length !== 1 || replies[0].text.trim() !== marker) throw fail(`run ${id} did not persist exactly one expected reply`);
      }
    }
    const expectedReplies = (interrupted ? 0 : 1) + (batched ? 1 : 2);
    return { ...evidence(), threadId, firstRun, exactlyOnceReplies: expectedReplies };
  });
}
