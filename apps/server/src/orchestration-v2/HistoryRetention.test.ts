import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as HistoryRetention from "./HistoryRetention.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provideMerge(database)),
  ProjectionStore.layer.pipe(Layer.provideMerge(database)),
);
const layerTest = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
  HistoryRetention.layer.pipe(Layer.provide(database)),
);
const layerStorage = DatabaseStorage.layer.pipe(
  Layer.provideMerge(layerTest),
  Layer.provide(ServerSettings.layerTest({ storageCleanup: { threadHistoryAfterDays: 3 } })),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "history-retention-" })),
  Layer.provide(NodeServices.layer),
);

const providerInstanceId = ProviderInstanceId.make("claude");
const providerDriver = ProviderDriverKind.make("claudeAgent");

const makeThread = (
  threadId: ThreadId,
  now: DateTime.Utc,
  archivedAt: DateTime.Utc | null,
): OrchestrationV2AppThread => ({
  id: threadId,
  projectId: ProjectId.make(`project:${threadId}`),
  title: "History retention",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "claude-haiku-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const boundaryText = "a".repeat(2047) + "😀" + "b".repeat(10_000) + "\u001b[31m" + "c".repeat(2045);
const longText = (label: string) =>
  `${label}:head:` + "h".repeat(3000) + "m".repeat(20_000) + "t".repeat(3000) + `:${label}:tail`;

const turnItem = (
  threadId: ThreadId,
  now: DateTime.Utc,
  key: string,
  ordinal: number,
  completed: boolean,
  fields:
    | { readonly type: "command_execution"; readonly input: string; readonly output: string }
    | { readonly type: "dynamic_tool"; readonly input: unknown; readonly output: unknown },
): OrchestrationV2TurnItem => {
  const base = {
    id: TurnItemId.make(`turn-item:${threadId}:${key}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: completed ? ("completed" as const) : ("running" as const),
    title: key,
    startedAt: now,
    completedAt: completed ? now : null,
    updatedAt: now,
  };
  return fields.type === "command_execution"
    ? { ...base, ...fields }
    : { ...base, ...fields, toolName: "mcp__t3__thread_read" };
};

const threadEvents = (threadId: ThreadId, now: DateTime.Utc, archivedAt: DateTime.Utc | null) => {
  const event = (
    key: string,
    rest: Omit<OrchestrationV2DomainEvent, "id" | "threadId" | "occurredAt">,
  ) =>
    ({
      id: EventId.make(`event:${threadId}:${key}`),
      threadId,
      occurredAt: now,
      ...rest,
    }) as OrchestrationV2DomainEvent;
  const subagentId = NodeId.make(`subagent:${threadId}`);
  const workflow = (revision: number) => ({
    name: "review",
    phases: [{ index: 0, title: "Review" }],
    agents: Array.from({ length: revision + 1 }, (_, index) => ({
      index,
      label: `agent ${index}`,
      state: "completed" as const,
      prompt: `prompt ${index} `.repeat(400),
      result: `result ${index} `.repeat(400),
    })),
  });
  return [
    event("created", {
      type: "thread.created",
      providerInstanceId,
      payload: makeThread(threadId, now, archivedAt),
    }),
    event("command:0", {
      type: "turn-item.updated",
      payload: turnItem(threadId, now, "command", 10, false, {
        type: "command_execution",
        input: "vp test run",
        output: "",
      }),
    }),
    event("command:1", {
      type: "turn-item.updated",
      payload: turnItem(threadId, now, "command", 10, true, {
        type: "command_execution",
        input: "vp test run",
        output: longText("command"),
      }),
    }),
    event("tool", {
      type: "turn-item.updated",
      payload: turnItem(threadId, now, "tool", 20, true, {
        type: "dynamic_tool",
        input: { threadId: "thread:other" },
        output: {
          content: [
            { type: "text", text: longText("tool") },
            { type: "image", data: "i".repeat(20_000), mimeType: "image/png" },
          ],
          structuredContent: { rows: "s".repeat(9000) },
        },
      }),
    }),
    event("boundary", {
      type: "turn-item.updated",
      payload: turnItem(threadId, now, "boundary", 25, true, {
        type: "command_execution",
        input: "cat log",
        output: boundaryText,
      }),
    }),
    event("short", {
      type: "turn-item.updated",
      payload: turnItem(threadId, now, "short", 30, true, {
        type: "command_execution",
        input: "ls",
        output: "README.md\n",
      }),
    }),
    ...[0, 1, 2].map((revision) =>
      event(`subagent:${revision}`, {
        type: "subagent.updated",
        payload: {
          id: subagentId,
          threadId,
          runId: null,
          parentNodeId: NodeId.make(`node:${threadId}:parent`),
          origin: "provider_native",
          createdBy: "agent",
          driver: providerDriver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: { driver: providerDriver, nativeId: "review", strength: "strong" },
          prompt: "Review the retention change. ".repeat(40),
          progress: `phase ${revision}`,
          workflow: workflow(revision),
          title: "Review",
          model: null,
          status: revision === 2 ? "completed" : "running",
          result: revision === 2 ? "done" : null,
          startedAt: now,
          completedAt: revision === 2 ? now : null,
          updatedAt: now,
        },
      }),
    ),
  ];
};

const rawPayloads = (threadId: ThreadId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.all({
      events: sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events
        WHERE stream_id = ${threadId} ORDER BY sequence ASC
      `,
      turnItems: sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} ORDER BY ordinal ASC
      `,
    }),
  );

it.effect(
  "trims tool output and superseded workflows in idle threads and rebuilds to the same projection",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const retention = yield* HistoryRetention.HistoryRetention;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const idleThreadId = ThreadId.make("thread:history-retention:idle");
      const activeThreadId = ThreadId.make("thread:history-retention:active");
      const recentThreadId = ThreadId.make("thread:history-retention:recent");
      yield* sink.write({
        events: threadEvents(idleThreadId, now, DateTime.subtract(now, { days: 10 })),
      });
      yield* sink.write({ events: threadEvents(activeThreadId, now, null) });
      yield* sink.write({
        events: threadEvents(recentThreadId, now, DateTime.subtract(now, { hours: 1 })),
      });
      const activeBefore = yield* rawPayloads(activeThreadId);
      const recentBefore = yield* rawPayloads(recentThreadId);
      const idleBefore = yield* projections.getThreadProjection(idleThreadId);

      const result = yield* retention.trimIdleThreads({
        idleBefore: DateTime.subtract(now, { days: 3 }),
      });

      assert.deepEqual(yield* rawPayloads(activeThreadId), activeBefore);
      assert.deepEqual(yield* rawPayloads(recentThreadId), recentBefore);
      assert.include(result, { threads: 1, events: 5, turnItems: 3, skipped: 0 });
      assert.isAbove(result.bytesRemoved, 80_000);

      const idleAfter = yield* projections.getThreadProjection(idleThreadId);
      const outputs = new Map(
        idleAfter.turnItems.map((item) => [item.title, "output" in item ? item.output : undefined]),
      );
      const command = outputs.get("command");
      assert.isString(command);
      assert.isTrue((command as string).startsWith("command:head:hhh"));
      assert.isTrue((command as string).endsWith("ttt:command:tail"));
      assert.match(command as string, /T3 history retention v1 removed 21\d{3} characters/);
      assert.isBelow((command as string).length, 4500);
      const tool = outputs.get("tool") as {
        readonly content: ReadonlyArray<{ readonly text?: string; readonly data?: string }>;
        readonly structuredContent: { readonly rows: string };
      };
      assert.isTrue(tool.content[0]?.text?.startsWith("tool:head:hhh"));
      assert.isTrue(tool.content[0]?.text?.endsWith("ttt:tool:tail"));
      assert.isBelow(tool.content[0]?.text?.length ?? Infinity, 4500);
      assert.equal(tool.content[1]?.data?.length, 20_000);
      assert.equal(tool.structuredContent.rows.length, 9000);
      assert.equal(
        outputs.get("boundary"),
        "a".repeat(2047) +
          "\n\n[T3 history retention v1 removed 10007 characters]\n\n" +
          "c".repeat(2045),
      );
      assert.equal(outputs.get("short"), "README.md\n");
      assert.deepEqual(
        idleAfter.subagents.map((subagent) => subagent.workflow?.agents.length),
        idleBefore.subagents.map((subagent) => subagent.workflow?.agents.length),
      );

      const workflowRows = yield* sql<{ readonly has_workflow: number }>`
        SELECT json_type(payload_json, '$.workflow') IS NOT NULL AS has_workflow
        FROM orchestration_events
        WHERE stream_id = ${idleThreadId} AND event_type = 'subagent.updated'
        ORDER BY sequence ASC
      `;
      assert.deepEqual(
        workflowRows.map((row) => row.has_workflow),
        [0, 0, 1],
      );
      const latestCommandEvent = yield* sql<{ readonly output: string }>`
        SELECT json_extract(payload_json, '$.output') AS output
        FROM orchestration_events
        WHERE event_id = ${`event:${idleThreadId}:command:1`}
      `;
      assert.equal(latestCommandEvent[0]?.output, command);

      const verification = yield* maintenance.rebuild;
      assert.isTrue(verification.valid);
      assert.deepEqual(yield* projections.getThreadProjection(idleThreadId), idleAfter);

      const again = yield* retention.trimIdleThreads({
        idleBefore: DateTime.subtract(now, { days: 3 }),
      });
      assert.include(again, { events: 0, turnItems: 0, bytesRemoved: 0 });
      const later = yield* retention.trimIdleThreads({
        idleBefore: DateTime.add(now, { days: 1 }),
      });
      assert.include(later, { threads: 1, events: 5, turnItems: 3 });
      assert.deepEqual(yield* rawPayloads(activeThreadId), activeBefore);
    }).pipe(Effect.provide(layerTest)),
);

const commandOutput = (threadId: ThreadId, key: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly length: number }>`
      SELECT length(json_extract(payload_json, '$.output')) AS length
      FROM orchestration_events WHERE event_id = ${`event:${threadId}:${key}`}
    `,
  ).pipe(Effect.map((rows) => rows[0]?.length));

it.effect("rechecks that a thread is still idle when it writes", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const retention = yield* HistoryRetention.HistoryRetention;
    const now = yield* DateTime.now;
    const archivedAt = DateTime.subtract(now, { days: 10 });
    const first = ThreadId.make("thread:history-retention:a");
    const reopened = ThreadId.make("thread:history-retention:b");
    yield* sink.write({ events: threadEvents(first, now, archivedAt) });
    yield* sink.write({ events: threadEvents(reopened, now, archivedAt) });
    const before = yield* commandOutput(reopened, "command:1");
    let started = false;
    const result = yield* retention.trimIdleThreads({
      idleBefore: DateTime.subtract(now, { days: 3 }),
      betweenPages: Effect.suspend(() => {
        if (started) return Effect.void;
        started = true;
        return sink
          .write({
            events: [
              {
                id: EventId.make(`event:${reopened}:started`),
                threadId: reopened,
                occurredAt: now,
                type: "turn-item.updated",
                payload: turnItem(reopened, now, "started", 40, false, {
                  type: "command_execution",
                  input: "vp run dev",
                  output: "",
                }),
              },
            ],
          })
          .pipe(Effect.orDie);
      }),
    });
    assert.include(result, { threads: 1, events: 5, turnItems: 3 });
    assert.equal(yield* commandOutput(reopened, "command:1"), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pages raw events and skips a rewrite larger than one write batch", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const retention = yield* HistoryRetention.HistoryRetention;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:history-retention:large");
    const [created] = threadEvents(threadId, now, DateTime.subtract(now, { days: 10 }));
    const item = (key: string, ordinal: number, input: string, output: string) =>
      ({
        id: EventId.make(`event:${threadId}:${key}`),
        threadId,
        occurredAt: now,
        type: "turn-item.updated",
        payload: turnItem(threadId, now, key, ordinal, true, {
          type: "command_execution",
          input,
          output,
        }),
      }) as OrchestrationV2DomainEvent;
    yield* sink.write({
      events: [
        created!,
        item("large", 1, "i".repeat(1_100_000), longText("large")),
        ...Array.from({ length: 450 }, (_, index) => item(`short:${index}`, index + 2, "ls", "ok")),
      ],
    });
    let pages = 0;
    const result = yield* retention.trimIdleThreads({
      idleBefore: DateTime.subtract(now, { days: 3 }),
      betweenPages: Effect.sync(() => {
        pages += 1;
      }),
    });
    assert.include(result, { events: 0, turnItems: 0, skipped: 1 });
    assert.isAtLeast(pages, 2);
    assert.equal(yield* commandOutput(threadId, "large"), longText("large").length);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rolls back event rewrites when the projection write fails", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const retention = yield* HistoryRetention.HistoryRetention;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:history-retention:crash");
    yield* sink.write({
      events: threadEvents(threadId, now, DateTime.subtract(now, { days: 10 })),
    });
    const before = yield* rawPayloads(threadId);
    yield* sql`
      CREATE TRIGGER history_retention_crash BEFORE UPDATE ON orchestration_v2_projection_turn_items
      BEGIN SELECT RAISE(ABORT, 'crash'); END
    `;
    const exit = yield* Effect.exit(
      retention.trimIdleThreads({ idleBefore: DateTime.subtract(now, { days: 3 }) }),
    );
    assert.isTrue(Exit.isFailure(exit));
    assert.deepEqual(yield* rawPayloads(threadId), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("resumes an idle thread from a snapshot so trimmed output reaches synced clients", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const storage = yield* DatabaseStorage.DatabaseStorage;
    const now = yield* DateTime.now;
    const idle = ThreadId.make("thread:history-retention:resume-idle");
    const active = ThreadId.make("thread:history-retention:resume-active");
    yield* sink.write({ events: threadEvents(idle, now, DateTime.subtract(now, { days: 10 })) });
    yield* sink.write({ events: threadEvents(active, now, null) });
    assert.deepEqual(yield* storage.threadSubscription({ threadId: idle, afterSequence: 3 }), {
      threadId: idle,
    });
    assert.deepEqual(yield* storage.threadSubscription({ threadId: active, afterSequence: 3 }), {
      threadId: active,
      afterSequence: 3,
    });
  }).pipe(Effect.provide(layerStorage)),
);
