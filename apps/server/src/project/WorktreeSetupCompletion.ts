import * as NodeUtil from "node:util";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProjectSetupScriptCompletion } from "./ProjectSetupScriptRunner.ts";
import type { WorktreeSetupTracker } from "./WorktreeSetupTracker.ts";

export const completeSetupScript = Effect.fn("WorktreeSetupCompletion.awaitCompletion")(function* (
  threadId: ThreadId,
  completion: Effect.Effect<ProjectSetupScriptCompletion>,
  tracker: WorktreeSetupTracker["Service"],
) {
  const { exitCode } = yield* completion;
  let reason = "";
  if (exitCode !== 0) {
    const snapshot = yield* tracker.get(threadId);
    const tail = snapshot?.stages.find((stage) => stage.id === "setup-script")?.tail ?? [];
    reason = tail
      .flatMap((line) => NodeUtil.stripVTControlCharacters(line).split(/[\r\n]+/))
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.includes("__T3_SETUP_DONE__"))
      .slice(-3)
      .join("\n");
    if (reason.length > 500) reason = `…${reason.slice(-499)}`;
  }
  const detail = `exited with ${exitCode ?? "no exit code"}`;
  yield* tracker.stage(threadId, "setup-script", {
    status: exitCode === 0 ? "done" : "failed",
    detail: reason ? `${detail}: ${reason}` : detail,
  });
  return exitCode === 0 ? null : `Setup script ${detail}${reason ? `: ${reason}` : "."}`;
});
