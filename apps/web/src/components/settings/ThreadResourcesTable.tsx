import type { EnvironmentId, ResourceTelemetryThread } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useProjects, useThreadShells } from "../../state/entities";
import { formatBytes } from "../../lib/formatBytes";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export function ThreadResourcesTable({
  rows,
  environmentId,
}: {
  rows: ReadonlyArray<ResourceTelemetryThread> | undefined;
  environmentId: EnvironmentId | null;
}) {
  const [sort, setSort] = useState("cpuPercent");
  const threads = useThreadShells();
  const projects = useProjects();
  if (!rows) return null;
  const value = (row: ResourceTelemetryThread) =>
    sort === "residentBytes"
      ? row.residentBytes
      : sort === "processCount"
        ? row.processCount
        : row.cpuPercent;
  const ranked = rows.toSorted((a, b) => value(b) - value(a) || a.key.localeCompare(b.key));
  const total = rows.reduce((sum, row) => sum + value(row), 0);
  return (
    <section className="space-y-3 border-b border-border/70 px-5 py-4" aria-label="Threads">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Threads</h3>
        <ToggleGroup
          value={[sort]}
          onValueChange={(values) => {
            if (values[0]) setSort(values[0]);
          }}
          aria-label="Sort threads"
        >
          <Toggle value="cpuPercent">CPU</Toggle>
          <Toggle value="residentBytes">Memory</Toggle>
          <Toggle value="processCount">Processes</Toggle>
        </ToggleGroup>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-2 text-left font-normal">Thread</th>
              <th className="px-3 text-right font-normal">CPU</th>
              <th className="px-3 text-right font-normal">Memory</th>
              <th className="px-3 text-right font-normal">Processes</th>
              <th className="w-24 text-right font-normal">Share</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((row) => {
              const thread = threads.find(
                (entry) => entry.environmentId === environmentId && entry.id === row.threadId,
              );
              const project =
                thread &&
                projects.find(
                  (entry) => entry.environmentId === environmentId && entry.id === thread.projectId,
                );
              return (
                <tr key={row.key} className="border-t border-border/60">
                  <td className="max-w-64 py-3">
                    {thread && environmentId ? (
                      <Link
                        className="block truncate hover:underline"
                        to="/$environmentId/$threadId"
                        params={{ environmentId, threadId: thread.id }}
                      >
                        {thread.title}
                      </Link>
                    ) : (
                      <span className="block truncate">{row.threadId ?? row.label}</span>
                    )}
                    <span className="block truncate text-xs text-muted-foreground">
                      {project?.title ?? (row.threadId ? "Thread" : "T3 processes")}
                      {row.terminalCount > 0 &&
                        ` · ${row.terminalCount} ${row.terminalCount === 1 ? "terminal" : "terminals"}`}
                    </span>
                  </td>
                  <td className="px-3 text-right">{row.cpuPercent.toFixed(1)}%</td>
                  <td className="whitespace-nowrap px-3 text-right">
                    {formatBytes(row.residentBytes)}
                  </td>
                  <td className="px-3 text-right">{row.processCount}</td>
                  <td className="pl-3">
                    <div
                      className="h-1.5 overflow-hidden rounded-full bg-muted"
                      role="img"
                      aria-label={`${total > 0 ? ((value(row) / total) * 100).toFixed(1) : 0}% share`}
                    >
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${total > 0 ? (value(row) / total) * 100 : 0}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No sampled processes.</p>}
    </section>
  );
}
