// @effect-diagnostics nodeBuiltinImport:off -- the SDK spawns the CLI through a Node ChildProcess.
import * as NodeChildProcess from "node:child_process";

import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

const CLAUDE_GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

const liveGroups = new Set<NodeChildProcess.ChildProcess>();

/**
 * Kill the CLI's group on exit to stop MCP grandchildren; `onExit` stops its agent scope for
 * setsid daemons. The CLI keeps working after its pipes close, so a watcher stops the group on
 * EOF from a pipe only this server holds, including when the server crashes.
 */
export function spawnClaudeProcessGroup(
  options: ClaudeSpawnOptions,
  onExit?: () => void,
): ClaudeSpawnedProcess {
  const child = NodeChildProcess.spawn(
    "/bin/sh",
    ["-c", CLAUDE_GROUP_WATCH_SCRIPT, "t3-claude", options.command, ...options.args],
    {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore", "pipe"],
      detached: true,
    },
  );
  liveGroups.add(child);
  child.once("exit", () => {
    liveGroups.delete(child);
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
    } catch {}
    onExit?.();
  });
  // Node's typings make stdin and stdout nullable once stdio has a fourth entry; both are pipes.
  return child as ClaudeSpawnedProcess;
}

export function releaseClaudeBackgroundWork(): number {
  let released = 0;
  for (const child of liveGroups) {
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
      released += 1;
    } catch {}
  }
  return released;
}
