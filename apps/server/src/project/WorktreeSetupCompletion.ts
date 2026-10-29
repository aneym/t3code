import * as NodeUtil from "node:util";
import type { ThreadId } from "@t3tools/contracts";
import { WORKTREE_SETUP_DETAIL_MAX_LENGTH } from "@t3tools/contracts";
import { redactProviderFailureText } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import type { ProjectSetupScriptCompletion } from "./ProjectSetupScriptRunner.ts";
import type { WorktreeSetupTracker } from "./WorktreeSetupTracker.ts";

function tailText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let start = text.length - maxLength + 1;
  const firstCodeUnit = text.charCodeAt(start);
  if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) start += 1;
  return `…${text.slice(start)}`;
}

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
      .map(redactProviderFailureText)
      .join("\n");
    reason = tailText(reason, 500);
  }
  const detail = `exited with ${exitCode ?? "no exit code"}`;
  yield* tracker.stage(threadId, "setup-script", {
    status: exitCode === 0 ? "done" : "failed",
    detail: reason
      ? `${detail}: ${tailText(reason, WORKTREE_SETUP_DETAIL_MAX_LENGTH - detail.length - 2)}`
      : detail,
  });
  return exitCode === 0 ? null : `Setup script ${detail}${reason ? `: ${reason}` : "."}`;
});
