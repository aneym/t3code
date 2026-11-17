import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

const REMOVAL_SCRIPT_WARNINGS = new Set([
  "This shell -c script runs rm and could not be checked",
  "A permission rule denies a command in this shell -c script",
]);

export const CLAUDE_HEADLESS_CHILD_NOTICE_TITLE = "Safety check declined";

export function claudeBypassAskRefusal(input: {
  readonly toolName: string;
  readonly toolUseID: string;
  readonly reason: string;
  readonly bypassRefused: boolean;
  readonly delegatedChild: boolean;
}): { readonly notice?: string; readonly result: PermissionResult } | undefined {
  if (!input.bypassRefused) return undefined;
  const removal =
    input.toolName === "Bash" &&
    (/^Dangerous rm(?:dir)?\b/i.test(input.reason) || REMOVAL_SCRIPT_WARNINGS.has(input.reason));
  if (removal) {
    return {
      result: {
        behavior: "deny",
        message: `Claude Code's removal safety check denied this command; the user did not reject it. The command did not run. Do not bypass the check by splitting the removal, putting it in a script, or using another tool or shell. If the warning below supplies a safe rewrite, use it and let the same check evaluate it. Otherwise continue the rest of the task without the removal and tell the user what you needed to delete and why. Warning: ${input.reason}`,
        toolUseID: input.toolUseID,
      },
    };
  }
  if (!input.delegatedChild) return undefined;
  const check = input.reason === "" ? "" : ` Check: ${input.reason}`;
  return {
    notice: `Claude Code asked to approve ${input.toolName} in a delegated Full access run. Nobody approves here, so T3 declined it at once and the agent was told to rewrite it.${check}`,
    result: {
      behavior: "deny",
      message: `Headless child: Claude Code's safety check needs approval for this ${input.toolName} call, and nobody approves in a delegated Full access run, so it was declined and did not run. The user did not reject it. Rewrite it so the check can read it: drop backticks and \${...} from inside heredocs, or write the script or file contents with the Write tool first and run that file. Do not ask for approval.${check}`,
      toolUseID: input.toolUseID,
    },
  };
}
