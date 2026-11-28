import { assert, describe, it } from "@effect/vitest";

import {
  boundAgentsKernel,
  buildRuntimeInstructions,
  MAX_AGENTS_KERNEL_BYTES,
} from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("links PRs the agent creates, takes over, or pushes to, and no others", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.include(instructions, "Link each PR you create, take over, or push to");
    assert.include(instructions, "one link_pull_request per PR");
    assert.include(instructions, "Skip PRs you only read or review");
    assert.include(instructions, "If linking fails, say so.");
    assert.notInclude(instructions, "git log -1");
    assert.notInclude(instructions, "work on");
    // Listing linked PRs as an end-of-work check found nothing to add in audited threads.
    assert.notInclude(instructions, "list_thread_pull_requests");
  });

  it("waits on a PR only with the watch, never with a poll loop", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });

    assert.notInclude(instructions, "Creation, pending checks, or a merge ask alone is not enough");
    assert.include(instructions, "Links and watches persist across pushes.");
    // The wake message itself carries the do-not-re-watch rule.
    assert.notInclude(instructions, "On a wake");
    assert.include(
      instructions,
      "Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch",
    );
    assert.notInclude(instructions, "merge it now");
    assert.include(instructions, "Otherwise act now or hand back.");
    assert.include(instructions, "then watch and end your turn");
    assert.include(instructions, "never watch, even if the brief says babysit");
    assert.include(
      instructions,
      "After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>.",
    );
    assert.include(instructions, "Never wait with sleep");
    assert.include(instructions, "call unwatch_pull_request");
  });

  it("injects a bounded agents kernel only when provided", () => {
    const baseline = buildRuntimeInstructions({ harness: "Antigravity" });
    assert.notInclude(baseline, "<agents_kernel>");
    assert.strictEqual(
      buildRuntimeInstructions({ harness: "Antigravity", agentsKernel: "   \n  " }),
      baseline,
    );

    const withKernel = buildRuntimeInstructions({
      harness: "Antigravity",
      agentsKernel: "# Global Kernel\nFollow rails conventions.",
    });
    assert.include(
      withKernel,
      "<agents_kernel>\n# Global Kernel\nFollow rails conventions.\n</agents_kernel>",
    );

    const oversized = `🦊${"a".repeat(MAX_AGENTS_KERNEL_BYTES * 2)}`;
    const bounded = boundAgentsKernel(oversized);
    assert.isDefined(bounded);
    assert.isAtMost(Buffer.byteLength(bounded!, "utf8"), MAX_AGENTS_KERNEL_BYTES);
    assert.include(bounded!, "... [truncated]");
  });
});
