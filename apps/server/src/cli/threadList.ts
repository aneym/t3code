import {
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadStatus,
  type OrchestratorMcpThreadListItem,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { printJson, withOwnerMcpTools } from "./ownerMcpTools.ts";
import { ThreadUsageError, jsonFlag, reportThreadErrors } from "./threadCommon.ts";
import { resolveProject } from "./threadProject.ts";

const decodeStatusList = Schema.decodeUnknownEffect(
  Schema.Array(OrchestratorMcpThreadStatus).check(Schema.isMaxLength(10)),
);

const decodeStatuses = (value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => Effect.void,
    onSome: (text) =>
      decodeStatusList(text.split(",").map((status) => status.trim())).pipe(
        Effect.mapError(() => new ThreadUsageError({ detail: `'${text}' is not a status list.` })),
      ),
  });

export const threadListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or a path inside the project. Defaults to this directory."),
    Flag.withDefault("."),
  ),
  allProjects: Flag.Boolean("all-projects").pipe(
    Flag.withDescription("Every project's threads. Leaves out --project."),
    Flag.withDefault(false),
  ),
  subagents: Flag.Literals("subagents", ["exclude", "include", "only"]).pipe(
    Flag.withDescription(
      "Delegated child threads: left out by default, included with include, or listed alone with only.",
    ),
    Flag.withDefault("exclude"),
  ),
  status: Flag.String("status").pipe(
    Flag.withDescription(
      "Only threads in these comma-separated statuses, such as failed or running.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List a project's threads, newest first."),
  Command.withHandler((flags) =>
    withOwnerMcpTools(
      "thread",
      flags,
      Effect.fn("cli.thread.list")(function* (tools) {
        const scope = flags.allProjects
          ? { allProjects: true }
          : { projectId: (yield* resolveProject(tools, flags.project)).id };
        const statuses = yield* decodeStatuses(flags.status);
        const threads: Array<OrchestratorMcpThreadListItem> = [];
        let cursor: number | null = 0;
        while (cursor !== null) {
          const page: OrchestratorMcpThreadListResult = yield* tools.call(
            "t3_thread_list",
            {
              ...scope,
              includeSubagents: flags.subagents === "include",
              onlySubagents: flags.subagents === "only",
              ...(statuses === undefined ? {} : { statuses }),
              limit: 100,
              cursor,
            },
            OrchestratorMcpThreadListResult,
          );
          threads.push(...page.threads);
          cursor = page.nextCursor;
        }
        if (flags.json) {
          return yield* printJson(threads);
        }
        for (const thread of threads) {
          const child = thread.relationshipToParent === "subagent" ? "  (subagent)" : "";
          yield* Console.log(
            `${thread.threadId}  ${thread.status.padEnd(11)}  ${thread.title}${child}`,
          );
        }
      }),
    ).pipe(reportThreadErrors),
  ),
);
