import {
  type AgentPlacementHold,
  type AgentPlacementRoom,
  agentPlacementHealthBreach,
  agentPlacementResourcesFresh,
  agentPlacementRoomFull,
  CommandId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { agentHomeOfPath } from "../agents/AgentHomeOfPath.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ChildProvider,
  ClaimedSlot,
  type ClaimResult,
  makeClaims,
} from "./DelegatedChildClaims.ts";
import {
  allows,
  type ChildOrigin,
  childStartLimits,
  EVERY_CHILD,
  groupFullText,
  type GroupLimit,
  healthLineFor,
  limitedGroups,
  limitOf,
} from "./DelegatedChildLimits.ts";
import { type PlacedChild, tallyChildren } from "./DelegatedChildTally.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const TICK = Duration.seconds(1);

interface ChildRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly status: string;
  readonly held: number | null;
  readonly worktree: number;
  readonly root_project_id: string | null;
  readonly provider: string | null;
  readonly parent: string | null;
  readonly requested_at: string;
  readonly started_at: string | null;
}

interface ActiveChild extends ChildOrigin {
  readonly child_thread_id: string;
  readonly root_project_id: string | null;
}

type HeldRun = Pick<OrchestrationV2Run, "id" | "status" | "childStartHeld">;

type AdmitOwner = ({ readonly parentThreadId: ThreadId } | { readonly projectId: ProjectId }) & {
  readonly provider?: string;
};

export class DelegatedChildStartGate extends Context.Service<
  DelegatedChildStartGate,
  {
    readonly admit: <A, E, R>(
      owner: AdmitOwner,
      dispatch: (held: boolean) => Effect.Effect<A, E, R>,
      refuse?: (reason: string) => E,
    ) => Effect.Effect<A, E, R>;
    readonly isHeld: (run: HeldRun) => boolean;
    readonly claim: (owner: AdmitOwner) => Effect.Effect<ClaimResult>;
    readonly unclaim: (token: number) => Effect.Effect<void>;
    readonly room: Effect.Effect<AgentPlacementRoom>;
    readonly hold: (runId: RunId) => Effect.Effect<AgentPlacementHold | undefined>;
    readonly expired: (runId: RunId, now: number) => Effect.Effect<string | undefined>;
  }
>()("t3/orchestration-v2/DelegatedChildStartGate") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const resources = Option.getOrUndefined(yield* Effect.serviceOption(HostResources.HostResources));
  const environment = Option.getOrUndefined(
    yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment),
  );
  const lock = yield* Semaphore.make(1);
  const lastStart = new Map<string, number>();
  const released = new Set<string>();
  const homeByProject = new Map<string, string | null>();
  const claims = makeClaims();
  let pending = true;

  const readConfig = settings.getSettings.pipe(
    Effect.flatMap((current) =>
      Effect.map(
        Effect.promise(() => childStartLimits(current.childStart)),
        (limits) => ({
          limits,
          byRoom: current.agentPlacementByRoom,
          paused: current.agentPlacementPaused,
          maxHoldMinutes: current.agentPlacementMaxHoldMinutes,
          line: current.agentPlacementHealthLine,
        }),
      ),
    ),
    Effect.orElseSucceed(() => ({
      limits: new Map<string, GroupLimit>() as ReadonlyMap<string, GroupLimit>,
      byRoom: false,
      paused: null,
      maxHoldMinutes: 60,
      line: undefined,
    })),
  );
  type Config = Effect.Success<typeof readConfig>;

  const label =
    environment === undefined
      ? Effect.succeed("this machine")
      : environment.getDescriptor.pipe(
          Effect.map((descriptor) => descriptor.label),
          Effect.orElseSucceed(() => "this machine"),
        );

  const breachOf = Effect.fn("DelegatedChildStartGate.breachOf")(function* (
    config: Config,
    now: number,
    groups: ReadonlyArray<string> = [],
  ) {
    if (!config.byRoom || config.line === undefined || resources === undefined) return undefined;
    const reading = yield* resources.read;
    return agentPlacementResourcesFresh(reading, now)
      ? agentPlacementHealthBreach(reading, healthLineFor(config.limits, groups, config.line))
      : undefined;
  });

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

  const rootProjectOf = (threadId: ThreadId) =>
    sql<{ readonly project_id: string }>`
      SELECT root.project_id
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_threads root
        ON root.thread_id = COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), t.thread_id)
      WHERE t.thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]?.project_id ?? null));

  const readChildren = (remote: boolean) => sql<ChildRow>`
    SELECT
      r.run_id,
      r.thread_id,
      r.status,
      json_extract(r.payload_json, '$.childStartHeld') AS held,
      json_extract(r.payload_json, '$.workspacePreparation') IS NOT NULL AS worktree,
      root.project_id AS root_project_id,
      json_extract(t.payload_json, '$.providerInstanceId') AS provider,
      json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent,
      r.requested_at,
      json_extract(r.payload_json, '$.startedAt') AS started_at
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
    LEFT JOIN orchestration_v2_projection_threads root
      ON root.thread_id = COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), t.thread_id)
    WHERE r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      AND r.status <> 'queued'
      AND t.deleted_at IS NULL
      AND (json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
        OR (${remote ? 1 : 0} = 1 AND json_extract(t.payload_json, '$.delegatedFrom') IS NOT NULL))
      AND COALESCE(json_extract(t.payload_json, '$.creationSource'), '') <> 'provider'
    ORDER BY r.requested_at, r.run_id
  `;

  const readActiveChildren = sql<ActiveChild>`
    SELECT s.child_thread_id, root.project_id AS root_project_id,
      json_extract(t.payload_json, '$.providerInstanceId') AS provider,
      json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent,
      NULL AS started_at
    FROM orchestration_v2_projection_nodes n
      INDEXED BY orchestration_v2_projection_nodes_live_idx
    JOIN orchestration_v2_projection_subagents s ON s.subagent_id = n.node_id
    JOIN orchestration_v2_projection_threads t ON t.thread_id = s.child_thread_id
    LEFT JOIN orchestration_v2_projection_threads root
      ON root.thread_id = COALESCE(json_extract(t.payload_json, '$.lineage.rootThreadId'), t.thread_id)
    WHERE n.status IN ('pending', 'starting', 'running', 'waiting')
      AND n.kind = 'subagent'
      AND s.origin = 'app_owned'
      AND t.deleted_at IS NULL
  `;

  const heldRow = (row: ChildRow) =>
    row.status === "preparing" && row.held === 1 && !released.has(row.run_id);

  const isHeld = (run: HeldRun) =>
    run.status === "preparing" && run.childStartHeld === true && !released.has(run.id);

  const tally = Effect.fn("DelegatedChildStartGate.tally")(function* (
    rows: ReadonlyArray<ChildRow>,
    activeChildren: ReadonlyArray<ActiveChild>,
    limits: ReadonlyMap<string, GroupLimit>,
  ) {
    const heldThreads = new Set(rows.filter(heldRow).map((row) => row.thread_id));
    const held: Array<PlacedChild> = [];
    const live = new Map<string, PlacedChild>();
    for (const row of rows) {
      const home = yield* homeOf(row.root_project_id);
      if (heldRow(row)) held.push({ ...row, id: row.run_id, home, started_at: undefined });
      else if (!heldThreads.has(row.thread_id))
        live.set(row.thread_id, {
          ...row,
          id: row.thread_id,
          home,
          started_at: row.started_at ?? undefined,
        });
    }
    for (const child of activeChildren) {
      const id = child.child_thread_id;
      if (!heldThreads.has(id) && !live.has(id))
        live.set(id, { ...child, id, home: yield* homeOf(child.root_project_id) });
    }
    const now = yield* Clock.currentTimeMillis;
    const counts = tallyChildren(limits, [...live.values()], held, now);
    return { ...counts, active: live.size, held: heldThreads.size };
  });

  const snapshot = Effect.fn("DelegatedChildStartGate.snapshot")(function* (config: Config) {
    const rows = yield* readChildren(config.byRoom);
    const activeChildren = yield* readActiveChildren;
    const counts = yield* tally(rows, activeChildren, config.limits);
    const cap = config.limits.get(EVERY_CHILD)?.perGroup ?? null;
    const active = cap === null ? counts.active : (counts.running.get(EVERY_CHILD) ?? 0);
    const held = cap === null ? counts.held : (counts.queued.get(EVERY_CHILD) ?? 0);
    const room: AgentPlacementRoom = {
      cap,
      active,
      held,
      free: cap === null ? null : Math.max(0, cap - active - held),
      ...(config.paused === null ? {} : { paused: config.paused }),
    };
    return { rows, counts, room };
  });

  const room = Effect.gen(function* () {
    const config = yield* readConfig;
    const current = (yield* snapshot(config)).room;
    const breach = yield* breachOf(config, yield* Clock.currentTimeMillis);
    return breach === undefined ? current : { ...current, breach };
  }).pipe(
    Effect.orElseSucceed((): AgentPlacementRoom => ({ cap: null, active: 0, held: 0, free: null })),
  );

  const hold: DelegatedChildStartGate["Service"]["hold"] = Effect.fn(
    "DelegatedChildStartGate.hold",
  )(
    function* (runId) {
      const config = yield* readConfig;
      const { rows, counts, room: current } = yield* snapshot(config);
      const held = rows.filter(heldRow);
      const index = held.findIndex((row) => row.run_id === runId);
      const row = held[index];
      if (row === undefined) return undefined;
      const now = yield* Clock.currentTimeMillis;
      const here = yield* label;
      const rowGroups = counts.groups.get(row.run_id) ?? [];
      const ahead = held
        .slice(0, index)
        .filter((other) =>
          (counts.waits.get(other.run_id) ?? []).some((group) => rowGroups.includes(group)),
        ).length;
      const blocked = rowGroups.find(
        (group) =>
          group !== EVERY_CHILD &&
          (limitOf(config.limits, group)?.perGroup ?? Infinity) <= (counts.running.get(group) ?? 0),
      );
      const reason =
        (yield* breachOf(config, now, rowGroups)) ??
        (rowGroups.includes(EVERY_CHILD) && current.cap !== null && current.active >= current.cap
          ? agentPlacementRoomFull(here, { ...current, free: 0 })
          : undefined) ??
        (blocked === undefined ? undefined : groupFullText(config.limits, blocked, here)) ??
        (ahead > 0
          ? `Queued behind ${ahead} older ${ahead === 1 ? "child" : "children"} on ${here}.`
          : `Starting next on ${here}.`);
      const since = Date.parse(row.requested_at);
      return {
        reason,
        position: ahead + 1,
        since,
        until: since + config.maxHoldMinutes * 60_000,
      };
    },
    Effect.orElseSucceed(() => undefined),
  );

  const expired: DelegatedChildStartGate["Service"]["expired"] = Effect.fn(
    "DelegatedChildStartGate.expired",
  )(function* (runId, now) {
    const current = yield* hold(runId);
    if (current === undefined || now < current.until) return undefined;
    const config = yield* readConfig;
    return `No room on ${yield* label} within ${config.maxHoldMinutes} min (${current.reason.replace(/\.$/, "")}). Delegate again to place it elsewhere.`;
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

  const decide = Effect.fn("DelegatedChildStartGate.decide")(function* (
    config: Config,
    owner: AdmitOwner,
    own?: number,
  ) {
    const { limits } = config;
    const remote = "projectId" in owner;
    if ((limits.size === 0 && !config.byRoom) || (remote && !config.byRoom)) return undefined;
    const rootProject = remote
      ? owner.projectId
      : yield* rootProjectOf(owner.parentThreadId).pipe(Effect.orElseSucceed(() => null));
    const groups = limitedGroups(limits, yield* homeOf(rootProject), {
      provider: owner.provider,
      parent: remote ? null : owner.parentThreadId,
    });
    if (groups.length === 0 && !config.byRoom) return undefined;
    const rows = yield* readChildren(config.byRoom).pipe(Effect.orElseSucceed(() => []));
    const activeChildren = yield* readActiveChildren.pipe(Effect.orElseSucceed(() => []));
    const { running, queued } = yield* tally(rows, activeChildren, limits);
    const now = yield* Clock.currentTimeMillis;
    const { counted, started } = claims.count(running, lastStart, now, own);
    const breach = yield* breachOf(config, now, groups).pipe(Effect.orElseSucceed(() => undefined));
    const held =
      breach !== undefined ||
      groups.some(
        (group) => (queued.get(group) ?? 0) > 0 || !allows(limits, group, counted, started, now),
      );
    return { groups, held, breach, now };
  });

  const admit: DelegatedChildStartGate["Service"]["admit"] = (owner, dispatch, refuse) =>
    lock.withPermit(
      Effect.gen(function* () {
        const own = Option.getOrUndefined(yield* Effect.serviceOption(ClaimedSlot))?.token;
        const provider = Option.getOrUndefined(yield* Effect.serviceOption(ChildProvider));
        const config = yield* readConfig;
        const decision = yield* decide(
          refuse ? { ...config, byRoom: true } : config,
          provider === undefined ? owner : { ...owner, provider: provider.instanceId },
          own,
        );
        if (own !== undefined) claims.take(own);
        if (decision === undefined) return yield* dispatch(false);
        const { groups, held, breach, now } = decision;
        if (held && refuse !== undefined)
          return yield* Effect.fail(refuse(breach ?? `No free builder slot on ${yield* label}.`));
        const result = yield* dispatch(held);
        if (held) pending = true;
        else for (const group of groups) lastStart.set(group, now);
        yield* Effect.logInfo("orchestration-v2.child-start.admit", {
          owner,
          groups,
          held,
          breach,
        });
        return result;
      }),
    );

  const claim: DelegatedChildStartGate["Service"]["claim"] = (owner) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const decision = yield* decide(yield* readConfig, owner);
          if (decision === undefined) return {};
          if (decision.held)
            return { wouldHold: decision.breach ?? `No free builder slot on ${yield* label}.` };
          return { token: claims.add(decision.groups, decision.now) };
        }),
      )
      .pipe(Effect.orElseSucceed((): ClaimResult => ({})));

  const unclaim: DelegatedChildStartGate["Service"]["unclaim"] = (token) =>
    Effect.sync(() => {
      claims.take(token);
    });

  const tick = lock
    .withPermit(
      Effect.gen(function* () {
        if (!pending) return;
        const config = yield* readConfig;
        const { limits } = config;
        const rows = yield* readChildren(config.byRoom);
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
        const activeChildren = yield* readActiveChildren;
        const counts = yield* tally(rows, activeChildren, limits);
        const { groups } = counts;
        const now = yield* Clock.currentTimeMillis;
        const { counted: running, started } = claims.count(counts.running, lastStart, now);
        const blocked = new Set<string>();
        for (const row of held) {
          const rowGroups = groups.get(row.run_id) ?? [];
          if (rowGroups.some((group) => blocked.has(group))) continue;
          if ((yield* breachOf(config, now, rowGroups)) !== undefined) continue;
          const shut = rowGroups.filter((group) => !allows(limits, group, running, started, now));
          if (shut.length > 0) {
            for (const group of shut) blocked.add(group);
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
            started.set(group, now);
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

  return DelegatedChildStartGate.of({ admit, claim, unclaim, isHeld, room, hold, expired });
});

export const layer = Layer.effect(DelegatedChildStartGate, make);
