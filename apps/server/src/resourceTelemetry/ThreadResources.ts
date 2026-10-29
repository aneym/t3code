import type { ResourceTelemetryProcess, ResourceTelemetryThread } from "@t3tools/contracts";

export function aggregateThreadResources(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  owners: ReadonlyMap<number, { readonly threadId: string; readonly terminalId?: string }>,
): ReadonlyArray<ResourceTelemetryThread> {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const rows = new Map<string, ResourceTelemetryThread>();
  const terminals = new Map<string, Set<string>>();
  for (const process of processes) {
    let current: ResourceTelemetryProcess | undefined = process;
    const seen = new Set<number>();
    let owner: { readonly threadId: string; readonly terminalId?: string } | undefined;
    let shared: string | undefined;
    while (current && !seen.has(current.identity.pid)) {
      seen.add(current.identity.pid);
      owner = owners.get(current.identity.pid);
      if (owner?.terminalId) break;
      const name = current.name.toLowerCase();
      if (
        /^(codex|opencode)(?:\.exe)?$/.test(name) ||
        (/^(node|bun|deno)(?:\.exe)?$/.test(name) &&
          /(?:^|[ /])(?:codex|opencode)(?:[ /]|$)/i.test(current.command))
      ) {
        shared = /codex/i.test(name + " " + current.command) ? "Codex" : "OpenCode";
        owner = undefined;
        break;
      }
      if (owner) break;
      current = byPid.get(current.ppid);
    }
    const key = owner ? `thread:${owner.threadId}` : shared ? `shared:${shared}` : "other";
    const row = rows.get(key) ?? {
      key,
      ...(owner ? { threadId: owner.threadId } : {}),
      label: shared ? `${shared} (shared)` : "Server and other T3 work",
      cpuPercent: 0,
      residentBytes: 0,
      processCount: 0,
      terminalCount: 0,
    };
    const ids = terminals.get(key) ?? new Set<string>();
    if (owner?.terminalId) ids.add(owner.terminalId);
    terminals.set(key, ids);
    rows.set(key, {
      ...row,
      cpuPercent: row.cpuPercent + process.cpuPercent,
      residentBytes: row.residentBytes + process.residentBytes,
      processCount: row.processCount + 1,
      terminalCount: ids.size,
    });
  }
  return [...rows.values()];
}
