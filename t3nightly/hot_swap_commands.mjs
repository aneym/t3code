import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

export function observeCommands({ opts, Effect, SubscriptionRef, Option, supervisor, sessionIdentities, data, save, elapsed }) {
  const threadId = `live-swap-command-probe:${randomUUID()}`;
  Object.assign(data, { commandSamples: 0, commandFailures: 0, maxCommandGapMs: 0, commandFlipGapMs: null, maxCommandWaitMs: 0, commandOverBudget: 0, commandObservations: [], commandFlips: [], commandProbe: { method: "orchestration.getThreadFamily", intervalMs: 200, timeoutMs: 8000, versionSource: "session.initialConfig.environment.serverVersion-or-prepared-session" } });
  let lastAnswer;
  return Effect.gen(function* () {
    while (!existsSync(opts.stop)) {
      const tick = performance.now();
      const option = yield* SubscriptionRef.get(supervisor.session);
      if (Option.isSome(option)) {
        const session = option.value;
        const identity = sessionIdentities.get(session);
        const config = yield* session.initialConfig.pipe(Effect.orElseSucceed(() => undefined));
        const startedAtMs = elapsed();
        const superseded = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(50);
            const current = yield* SubscriptionRef.get(supervisor.session);
            if (Option.isNone(current) || current.value !== session) return yield* Effect.fail("superseded");
          }
        });
        const result = yield* Effect.exit(Effect.raceFirst(session.client["orchestration.getThreadFamily"]({ threadId }).pipe(Effect.timeout("8 seconds")), superseded));
        const waitMs = performance.now() - tick;
        const atMs = elapsed();
        const row = { atMs, startedAtMs, waitMs, sessionId: identity?.id, outcome: result._tag };
        data.commandSamples++;
        data.maxCommandWaitMs = Math.max(data.maxCommandWaitMs, waitMs);
        if (waitMs > 8000) data.commandOverBudget++;
        if (result._tag === "Success") {
          row.serverVersion = config?.environment?.serverVersion ?? identity?.serverVersion;
          row.snapshotSequence = result.value.snapshotSequence;
          if (lastAnswer) {
            const gapMs = atMs - lastAnswer.atMs;
            data.maxCommandGapMs = Math.max(data.maxCommandGapMs, gapMs);
            if (row.serverVersion !== lastAnswer.serverVersion) {
              data.commandFlips.push({ old: lastAnswer, new: row, gapMs });
              data.commandFlipGapMs = Math.max(data.commandFlipGapMs ?? 0, gapMs);
            }
          }
          lastAnswer = row;
        } else {
          data.commandFailures++;
        }
        data.commandObservations.push(row);
        if (data.commandObservations.length > 128) data.commandObservations.shift();
        save();
      }
      yield* Effect.sleep(Math.max(1, 200 - (performance.now() - tick)));
    }
  });
}
