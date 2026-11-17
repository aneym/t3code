import {
  ArchivedThreadsListResult,
  type ArchivedThreadEntry,
  type ArchivedThreadsTotals,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { printJson, withOwnerMcpTools } from "./ownerMcpTools.ts";
import { ThreadUsageError, jsonFlag, reportThreadErrors } from "./threadCommon.ts";
import { resolveProject } from "./threadProject.ts";

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
      : `${Math.round(bytes / 1024)} KiB`;

export const threadArchivedCommand = Command.make("archived", {
  ...projectLocationFlags,
  olderThanDays: Flag.Int("older-than-days").pipe(
    Flag.withDescription(
      "Judge threads against this many days. Defaults to storageCleanup.archivedHistoryAfterDays.",
    ),
    Flag.optional,
  ),
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or a path inside the project. Defaults to every project."),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(
    Flag.withDescription("Stop after this many threads."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List archived threads oldest first with their size and history-trim verdict. Read-only.",
  ),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "thread",
      flags,
      Effect.fn("cli.thread.archived")(function* (tools) {
        const olderThanDays = Option.getOrUndefined(flags.olderThanDays);
        if (olderThanDays !== undefined && (olderThanDays < 1 || olderThanDays > 3650))
          return yield* new ThreadUsageError({ detail: "--older-than-days is 1 to 3650." });
        const projectId = Option.isSome(flags.project)
          ? (yield* resolveProject(tools, flags.project.value)).id
          : undefined;
        const max = Option.getOrUndefined(flags.limit);
        const threads: Array<ArchivedThreadEntry> = [];
        const totals: { -readonly [K in keyof ArchivedThreadsTotals]: number } = {
          threads: 0,
          bytes: 0,
          dueThreads: 0,
          dueBytes: 0,
          keptThreads: 0,
          trimmedThreads: 0,
          structureBytes: 0,
        };
        const kept: Record<string, number> = {};
        let first: ArchivedThreadsListResult | undefined;
        let cursor: string | null = null;
        do {
          const remaining = max === undefined ? 100 : Math.min(100, max - threads.length);
          if (remaining <= 0) break;
          const page: ArchivedThreadsListResult = yield* tools.call(
            "t3_thread_archived",
            {
              ...(olderThanDays === undefined ? {} : { olderThanDays }),
              ...(projectId === undefined ? {} : { projectId }),
              limit: remaining,
              cursor,
            },
            ArchivedThreadsListResult,
          );
          first ??= page;
          threads.push(...page.threads);
          for (const key of Object.keys(totals) as Array<keyof ArchivedThreadsTotals>)
            totals[key] += page.totals[key];
          for (const thread of page.threads)
            if (thread.keptReason !== null)
              kept[thread.keptReason] = (kept[thread.keptReason] ?? 0) + 1;
          cursor = page.nextCursor;
        } while (cursor !== null);
        if (first === undefined) return;
        const report = { ...first, totals, keptByReason: kept, threads, nextCursor: cursor };
        if (flags.json) return yield* printJson(report);
        for (const thread of threads) {
          const verdict = thread.keptReason === null ? thread.verdict : `kept:${thread.keptReason}`;
          yield* Console.log(
            `${thread.threadId}  ${verdict.padEnd(22)}  ${String(thread.archivedDays).padStart(4)}d  ${formatBytes(thread.trimmableBytes).padStart(9)} of ${formatBytes(thread.bytes).padEnd(9)}  ${thread.title}`,
          );
        }
        yield* Console.log(
          `${totals.threads} archived, ${totals.dueThreads} due (${formatBytes(totals.dueBytes)}), ${totals.keptThreads} kept, ${totals.trimmedThreads} trimmed. Database ${formatBytes(first.database.bytes)}, ${formatBytes(first.database.freeBytes)} free, incremental vacuum ${first.database.incrementalVacuum ? "on" : "off"}.`,
        );
      }),
    ).pipe(reportThreadErrors),
  ),
);
