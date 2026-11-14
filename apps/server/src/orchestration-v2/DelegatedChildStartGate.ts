import { CommandId, ProjectId, RunId, ThreadId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { agentHomeOfPath } from "../agents/AgentHomeOfPath.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const EVERY_CHILD = "*";
const TICK = Duration.seconds(1);

interface GroupLimit {
  readonly perGroup: number | undefined;
  readonly staggerMs: number | undefined;
}

interface ChildRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly status: string;
  readonly held: number | null;
  readonly worktree: number;
  readonly root_project_id: string | null;
}

type HeldRun = Pick<OrchestrationV2Run, "id" | "status" | "childStartHeld">;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInt = (value: unknown, min: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : undefined;

const childStartLimits = (raw: unknown): ReadonlyMap<string, GroupLimit> => {
  const limits = new Map<string, GroupLimit>();
  if (!isRecord(raw)) return limits;
  for (const [group, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const limit = {
      perGroup: positiveInt(entry.perGroup, 1),
      staggerMs: positiveInt(entry.staggerMs, 0),
    };
    if (limit.perGroup !== undefined || limit.staggerMs !== undefined) limits.set(group, limit);
  }
  return limits;
};

export class DelegatedChildStartGate extends Context.Service<
  DelegatedChildStartGate,
  {
    readonly admit: <A, E, R>(
      parentThreadId: ThreadId,
      dispatch: (held: boolean) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly isHeld: (run: HeldRun) => boolean;
  }
>()("t3/orchestration-v2/DelegatedChildStartGate") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const lock = yield* Semaphore.make(1);
  const lastStart = new Map<string, number>();
  const released = new Set<string>();
  const homeByProject = new Map<string, string | null>();
  let pending = true;

  const readLimits = settings.getSettings.pipe(
    Effect.map((current) => childStartLimits(current.childStart)),
    Effect.orElseSucceed((): ReadonlyMap<string, GroupLimit> => new Map()),
  );

  const homeOf = Effect.fn("DelegatedChildStartGate.homeOf")(function* (projectId: string | null) {
    if (projectId === null) return null;
    const known = homeByProject.get(projectId);
    if (known !== undefined) return known;
    const project = yield* projects
      .getById(ProjectId.make(projectId))
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) return null;
    const location = yield* Effect.promise(() => agentHomeOfPath(project.value.workspaceRoot));
    homeByProject.set(projectId, location?.handle ?? null);
    return location?.handle ?? null;
  });

  const groupsOf = Effect.fn("DelegatedChildStartGate.groupsOf")(function* (
    rootProjectId: string | null,
    limits: ReadonlyMap<string, GroupLimit>,
  ) {
    const home = yield* homeOf(rootProjectId);
    return [home, EVERY_CHILD].filter(
      (group): group is string => group !== null && limits.has(group),
    );
  });

  const rootProjectOf = (threadId: ThreadId) =>
    sql<{ readonly project_id: string }>`
      SELECT root.project_id
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_threads root
        ON root.thread_id = COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), t.thread_id)
      WHERE t.thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]?.project_id ?? null));

  const readChildren = sql<ChildRow>`
    SELECT
      r.run_id,
      r.thread_id,
      r.status,
      json_extract(r.payload_json, '$.childStartHeld') AS held,
      json_extract(r.payload_json, '$.workspacePreparation') IS NOT NULL AS worktree,
      root.project_id AS root_project_id
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
    LEFT JOIN orchestration_v2_projection_threads root
      ON root.thread_id = COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), t.thread_id)
    WHERE r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      AND r.status <> 'queued'
      AND t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND COALESCE(json_extract(t.payload_json, '$.creationSource'), '') <> 'provider'
    ORDER BY r.requested_at, r.run_id
  `;

  const heldRow = (row: ChildRow) =>
    row.status === "preparing" && row.held === 1 && !released.has(row.run_id);

  const isHeld = (run: HeldRun) =>
    run.status === "preparing" && run.childStartHeld === true && !released.has(run.id);

  const allows = (
    limits: ReadonlyMap<string, GroupLimit>,
    group: string,
    running: ReadonlyMap<string, number>,
    now: number,
  ) => {
    const limit = limits.get(group);
    return (
      limit === undefined ||
      ((limit.perGroup === undefined || (running.get(group) ?? 0) < limit.perGroup) &&
        (limit.staggerMs === undefined || now - (lastStart.get(group) ?? 0) >= limit.staggerMs))
    );
  };

  const tally = Effect.fn("DelegatedChildStartGate.tally")(function* (
    rows: ReadonlyArray<ChildRow>,
    limits: ReadonlyMap<string, GroupLimit>,
  ) {
    const running = new Map<string, number>();
    const queued = new Map<string, number>();
    const groups = new Map<string, ReadonlyArray<string>>();
    for (const row of rows) {
      const rowGroups = yield* groupsOf(row.root_project_id, limits);
      groups.set(row.run_id, rowGroups);
      const counts = heldRow(row) ? queued : running;
      for (const group of rowGroups) counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return { running, queued, groups };
  });

  const release = (row: ChildRow) => {
    const input = {
      commandId: CommandId.make(`command:child-start:${row.run_id}`),
      threadId: ThreadId.make(row.thread_id),
      runId: RunId.make(row.run_id),
    };
    return row.worktree === 1
      ? launches.prepareRun(input)
      : threads.dispatch({ type: "prepared-run.release", ...input }).pipe(Effect.asVoid);
  };

  const admit: DelegatedChildStartGate["Service"]["admit"] = (parentThreadId, dispatch) =>
    lock.withPermit(
      Effect.gen(function* () {
        const limits = yield* readLimits;
        if (limits.size === 0) return yield* dispatch(false);
        const rootProject = yield* rootProjectOf(parentThreadId).pipe(
          Effect.orElseSucceed(() => null),
        );
        const groups = yield* groupsOf(rootProject, limits);
        if (groups.length === 0) return yield* dispatch(false);
        const rows = yield* readChildren.pipe(Effect.orElseSucceed(() => []));
        const { running, queued } = yield* tally(rows, limits);
        const now = yield* Clock.currentTimeMillis;
        const held = groups.some(
          (group) => (queued.get(group) ?? 0) > 0 || !allows(limits, group, running, now),
        );
        const result = yield* dispatch(held);
        if (held) pending = true;
        else for (const group of groups) lastStart.set(group, now);
        yield* Effect.logInfo("orchestration-v2.child-start.admit", {
          parentThreadId,
          groups,
          held,
        });
        return result;
      }),
    );

  const tick = lock
    .withPermit(
      Effect.gen(function* () {
        if (!pending) return;
        const rows = yield* readChildren;
        for (const id of released) {
          if (!rows.some((row) => row.run_id === id && row.status === "preparing")) {
            released.delete(id);
          }
        }
        const held = rows.filter(heldRow);
        if (held.length === 0) {
          pending = false;
          return;
        }
        const limits = yield* readLimits;
        const { running, groups } = yield* tally(rows, limits);
        const now = yield* Clock.currentTimeMillis;
        const blocked = new Set<string>();
        for (const row of held) {
          const rowGroups = groups.get(row.run_id) ?? [];
          if (rowGroups.some((group) => blocked.has(group))) continue;
          const open = rowGroups.every((group) => allows(limits, group, running, now));
          if (!open) {
            for (const group of rowGroups) blocked.add(group);
            continue;
          }
          released.add(row.run_id);
          yield* release(row).pipe(
            Effect.tap(() =>
              Effect.logInfo("orchestration-v2.child-start.release", {
                threadId: row.thread_id,
                runId: row.run_id,
                groups: rowGroups,
              }),
            ),
            Effect.catchCause((cause) => {
              released.delete(row.run_id);
              return Effect.logWarning("orchestration-v2.child-start.release-failed", {
                runId: row.run_id,
                cause,
              });
            }),
          );
          for (const group of rowGroups) {
            running.set(group, (running.get(group) ?? 0) + 1);
            lastStart.set(group, now);
          }
        }
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.child-start.tick-failed", { cause }),
      ),
    );

  yield* forkParked(Effect.forever(Effect.sleep(TICK).pipe(Effect.andThen(tick))));

  return DelegatedChildStartGate.of({ admit, isHeld });
});

export const layer = Layer.effect(DelegatedChildStartGate, make);
