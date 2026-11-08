import {
  isCompactionCommandMessage,
  parseGoalCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

const NOTE_LIMIT = 20;
const NOTE_CHARS = 2_000;

interface NoteRow {
  readonly text: string | null;
  readonly createdAt: string;
  readonly senderTitle: string | null;
  readonly senderLabel: string | null;
  readonly senderEnvironmentId: string | null;
}

const sender = (row: NoteRow) =>
  row.senderTitle !== null && row.senderEnvironmentId === null
    ? `"${row.senderTitle}"`
    : row.senderEnvironmentId !== null
      ? `an agent on ${row.senderLabel ?? row.senderEnvironmentId}`
      : "an agent";

export const previousPromptStart = (
  run: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
) => {
  const controlMessages = new Set(
    messages
      .filter(
        (message) => isCompactionCommandMessage(message) || parseGoalCommand(message) !== null,
      )
      .map((message) => message.id),
  );
  return (
    runs.findLast(
      (candidate) =>
        candidate.ordinal < run.ordinal &&
        candidate.startedAt !== null &&
        !controlMessages.has(candidate.userMessageId),
    )?.startedAt ?? null
  );
};

export class ThreadNoteContext extends Context.Reference<{
  readonly quietNotes: (
    threadId: ThreadId,
    since: DateTime.Utc | null,
    until: DateTime.Utc,
  ) => Effect.Effect<string>;
}>("t3/orchestration-v2/ThreadNoteContext", {
  defaultValue: () => ({ quietNotes: () => Effect.succeed("") }),
}) {}

export const layer = Layer.effect(
  ThreadNoteContext,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const quietNotes = Effect.fn("ThreadNoteContext.quietNotes")(function* (
      threadId: ThreadId,
      since: DateTime.Utc | null,
      until: DateTime.Utc,
    ) {
      const rows = yield* sql<NoteRow>`
      SELECT json_extract(message.payload_json, '$.text') AS text,
        message.created_at AS createdAt,
        sender.title AS senderTitle,
        json_extract(message.payload_json, '$.senderEnvironmentLabel') AS senderLabel,
        json_extract(message.payload_json, '$.senderEnvironmentId') AS senderEnvironmentId
      FROM orchestration_v2_projection_messages AS message
      LEFT JOIN orchestration_v2_projection_threads AS sender
        ON sender.thread_id = json_extract(message.payload_json, '$.senderThreadId')
      WHERE message.thread_id = ${threadId}
        AND message.created_at > ${since === null ? "" : DateTime.formatIso(since)}
        AND message.created_at <= ${DateTime.formatIso(until)}
        AND message.run_id IS NULL
        AND message.role = 'user'
        AND json_extract(message.payload_json, '$.quietNote') = 1
      ORDER BY message.created_at DESC, message.message_id DESC
      LIMIT ${NOTE_LIMIT + 1}
    `.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to read quiet thread notes", { threadId, cause }).pipe(
            Effect.as([] as ReadonlyArray<NoteRow>),
          ),
        ),
      );
      if (rows.length === 0) return "";
      const shown = rows.slice(0, NOTE_LIMIT).toReversed();
      return [
        `Notes posted to this thread since your last turn, oldest first${rows.length > NOTE_LIMIT ? ` (only the latest ${NOTE_LIMIT})` : ""}. The user saw them; read them as context for the message below.`,
        ...shown.map(
          (row) =>
            `- From ${sender(row)} at ${row.createdAt.replace(/\.\d+Z$/, "Z")}:\n${(row.text ?? "").slice(0, NOTE_CHARS)}`,
        ),
      ].join("\n");
    });
    return { quietNotes };
  }),
);
