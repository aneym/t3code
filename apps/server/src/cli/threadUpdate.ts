import { ThreadMetadataMcpUpdateResult, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";
import { printJson, withOwnerMcpTools } from "./ownerMcpTools.ts";
import {
  ThreadUsageError,
  decodeThreadId,
  jsonFlag,
  reportThreadErrors,
  threadArgument,
} from "./threadCommon.ts";

const decodeTitle = Schema.decodeUnknownEffect(TrimmedNonEmptyString);

export const threadUpdateCommand = Command.make("update", {
  ...projectLocationFlags,
  thread: threadArgument,
  title: Flag.String("title").pipe(Flag.withDescription("New thread title.")),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rename a thread."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const title = yield* decodeTitle(flags.title).pipe(
        Effect.mapError(() => new ThreadUsageError({ detail: "The title is empty." })),
      );
      yield* withOwnerMcpTools(
        "thread",
        flags,
        Effect.fn("cli.thread.update")(function* (tools) {
          const result = yield* tools.call(
            "t3_thread_update",
            { threadId, action: "rename", title },
            ThreadMetadataMcpUpdateResult,
          );
          yield* flags.json
            ? printJson(result)
            : Console.log(`Renamed thread ${result.threadId} to ${result.title}.`);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);
