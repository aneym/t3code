import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

interface ClaudeProcessGroupLeader {
  readonly pid?: number | undefined;
  once(event: "exit", listener: () => void): unknown;
}

const liveGroups = new Map<ClaudeProcessGroupLeader, string>();

export function trackClaudeProcessGroup(child: ClaudeProcessGroupLeader, threadId: string): void {
  liveGroups.set(child, threadId);
  child.once("exit", () => liveGroups.delete(child));
}

export function releaseClaudeBackgroundWork(threadId: string): number {
  let released = 0;
  for (const [child, owner] of liveGroups) {
    if (owner !== threadId) continue;
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
      released += 1;
    } catch {}
  }
  return released;
}
