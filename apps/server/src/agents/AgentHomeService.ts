import {
  AgentHomeError,
  type AgentBindInput,
  type AgentBindResult,
  type AgentHomesSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NodeOS from "node:os";
import * as Path from "effect/Path";
import * as Equal from "effect/Equal";
import * as DateTime from "effect/DateTime";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import {
  homeFromDocument,
  isLaneThread,
  parseDocument,
  readDocumentText,
  readHomes,
  watchHomes,
  writeBinding,
} from "./AgentHomeFiles.ts";

export class AgentHomeService extends Context.Service<
  AgentHomeService,
  {
    readonly list: Effect.Effect<AgentHomesSnapshot, AgentHomeError>;
    readonly subscribe: () => Stream.Stream<AgentHomesSnapshot>;
    readonly bind: (input: AgentBindInput) => Effect.Effect<AgentBindResult, AgentHomeError>;
  }
>()("t3/agents/AgentHomeService") {}

export const layer = Layer.effect(
  AgentHomeService,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const context = yield* Effect.context<never>();
    const root =
      process.env.T3CODE_AGENT_HOMES_DIR ?? path.join(NodeOS.homedir(), ".agent-rails", "agents");
    const environment = yield* ServerEnvironment;
    const threads = yield* ThreadManagementService;
    const scheduledTasks = yield* ScheduledTaskService;
    const snapshots = yield* SubscriptionRef.make<AgentHomesSnapshot>({ homes: [] });
    const refreshLock = yield* Semaphore.make(1);
    const locks = new Map<string, Semaphore.Semaphore>();
    const refresh = Effect.fn("AgentHomeService.refresh")(function* () {
      const snapshot = yield* Effect.tryPromise({
        try: () => readHomes(root),
        catch: (cause) => new AgentHomeError({ message: "Unable to read agent homes", cause }),
      });
      const current = yield* SubscriptionRef.get(snapshots);
      if (!Equal.equals(snapshot, current)) yield* SubscriptionRef.set(snapshots, snapshot);
      return snapshot;
    });
    const list = refreshLock.withPermit(refresh());
    yield* list.pipe(Effect.catch((error) => Effect.logWarning(error.message)));
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        watchHomes(root, () => {
          Effect.runForkWith(context)(
            list.pipe(Effect.catch((error) => Effect.logWarning(error.message))),
          );
        }),
      ),
      (close) => Effect.sync(close),
    );
    const bind = Effect.fn("AgentHomeService.bind")(function* (input: AgentBindInput) {
      const readText = Effect.tryPromise({
        try: () => readDocumentText(root, input.handle),
        catch: (cause) =>
          new AgentHomeError({
            handle: input.handle,
            message: "Agent home missing or unreadable",
            cause,
          }),
      });
      let lock = locks.get(input.handle);
      if (!lock) {
        yield* readText;
        lock = Semaphore.makeUnsafe(1);
        locks.set(input.handle, lock);
      }
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const text = yield* readText;
          const doc = yield* Effect.try({
            try: () => parseDocument(text),
            catch: (cause) =>
              new AgentHomeError({ handle: input.handle, message: "Invalid agent.json", cause }),
          });
          const home = yield* Effect.try({
            try: () => homeFromDocument(root, input.handle, doc),
            catch: (cause) => new AgentHomeError({ message: "Invalid agent home", cause }),
          });
          const descriptor = yield* environment.getDescriptor;
          const environmentId = input.threadEnvironmentId ?? descriptor.environmentId;
          const threadId = input.threadId;
          const projects = input.projects?.map((name) => name.trim()).filter(Boolean);
          if (threadId === undefined && projects === undefined)
            return yield* new AgentHomeError({
              handle: input.handle,
              message: "Give a thread, projects, or both",
            });
          const bindThread =
            threadId !== undefined &&
            !(input.onlyIfUnbound && home.binding) &&
            !(
              home.binding !== null &&
              home.binding.threadId === threadId &&
              (home.binding.environmentId === null || home.binding.environmentId === environmentId)
            );
          const setProjects =
            projects !== undefined && projects.join("\n") !== home.projects.join("\n");
          if (!bindThread && !setProjects) return { home, changed: false };
          if (bindThread && (yield* Effect.promise(() => isLaneThread(root, threadId))))
            return yield* new AgentHomeError({
              handle: input.handle,
              message: "Lane threads cannot be agent main threads",
            });
          if (bindThread && environmentId === descriptor.environmentId) {
            const projection = yield* threads.getThreadRecords(threadId, []).pipe(
              Effect.mapError(
                () =>
                  new AgentHomeError({
                    handle: input.handle,
                    message: "Target thread does not exist on this environment",
                  }),
              ),
            );
            const { tasks } = yield* scheduledTasks.list().pipe(
              Effect.mapError(
                (cause) =>
                  new AgentHomeError({
                    message: "Unable to validate automation placement",
                    cause,
                  }),
              ),
            );
            const shell = yield* threads
              .getThreadShell(threadId)
              .pipe(
                Effect.mapError(
                  (cause) => new AgentHomeError({ message: "Unable to read target thread", cause }),
                ),
              );
            if (!shell)
              return yield* new AgentHomeError({
                message: "Target thread does not exist on this environment",
              });
            const boundToAutomation = tasks.some((task) => task.threadId === threadId);
            const automationOnly =
              shell.pinnedAt == null &&
              (shell.automationTaskId != null || boundToAutomation) &&
              (shell.latestUserAuthoredMessageAt == null ||
                (shell.automationPlacementAt != null &&
                  DateTime.toEpochMillis(shell.latestUserAuthoredMessageAt) <=
                    DateTime.toEpochMillis(shell.automationPlacementAt)));
            if (
              projection.thread.deletedAt !== null ||
              projection.thread.lineage.parentThreadId !== null ||
              projection.thread.forkedFrom !== null ||
              automationOnly
            )
              return yield* new AgentHomeError({
                handle: input.handle,
                message: "Subagent, fork and automation threads cannot be agent main threads",
              });
          }
          const at = DateTime.formatIso(yield* DateTime.now).replace(/\.\d{3}Z$/, "Z");
          yield* Effect.tryPromise({
            try: () =>
              writeBinding(
                root,
                input.handle,
                doc,
                bindThread
                  ? {
                      thread_id: threadId,
                      environment_id: environmentId,
                      host: input.host ?? descriptor.label.toLowerCase(),
                      at,
                      by: input.by ?? "t3",
                    }
                  : null,
                text,
                setProjects ? projects : undefined,
              ),
            catch: (cause) =>
              new AgentHomeError({
                handle: input.handle,
                message: "Unable to save agent binding",
                cause,
              }),
          });
          const snapshot = yield* list;
          const updated = snapshot.homes.find((entry) => entry.handle === input.handle);
          if (!updated)
            return yield* new AgentHomeError({ message: "Agent home disappeared after binding" });
          return { home: updated, changed: true };
        }),
      );
    });
    return { list, subscribe: () => SubscriptionRef.changes(snapshots), bind };
  }),
);
