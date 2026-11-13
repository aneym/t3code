import {
  AgentHomeError,
  CommandId,
  type ThreadId,
  type AgentBindInput,
  type AgentBindResult,
  type AgentHomesSnapshot,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import { ServerSettingsService } from "../serverSettings.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import {
  homeFromDocument,
  homesGeneration,
  isLaneThread,
  parseDocument,
  readDocumentText,
  readHomes,
  watchHomes,
  writeBinding,
  writeOffice,
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
    const defaultRoot = path.join(NodeOS.homedir(), ".agent-rails", "agents");
    const root = yield* Config.String("T3CODE_AGENT_HOMES_DIR").pipe(
      Config.withDefault(defaultRoot),
      Effect.orElseSucceed(() => defaultRoot),
    );
    const environment = yield* ServerEnvironment;
    const threads = yield* ThreadManagementService;
    const scheduledTasks = yield* ScheduledTaskService;
    const settings = yield* ServerSettingsService;
    const crypto = yield* SecureRandom.SecureRandom;
    const snapshots = yield* SubscriptionRef.make<AgentHomesSnapshot>({ homes: [] });
    const refreshLock = yield* Semaphore.make(1);
    const locks = new Map<string, Semaphore.Semaphore>();
    let snapshotGeneration: number | undefined;
    const refresh = Effect.fn("AgentHomeService.refresh")(function* () {
      const generation = homesGeneration(root);
      const snapshot = yield* Effect.tryPromise({
        try: () => readHomes(root),
        catch: (cause) => new AgentHomeError({ message: "Unable to read agent homes", cause }),
      }).pipe(Effect.tapError(() => Effect.sync(() => (snapshotGeneration = undefined))));
      const current = yield* SubscriptionRef.get(snapshots);
      if (!Equal.equals(snapshot, current)) yield* SubscriptionRef.set(snapshots, snapshot);
      snapshotGeneration = generation;
      return snapshot;
    });
    const reload = refreshLock.withPermit(refresh());
    const list = Effect.suspend(() => {
      const generation = homesGeneration(root);
      return generation !== undefined && generation === snapshotGeneration
        ? SubscriptionRef.get(snapshots)
        : reload;
    });
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        watchHomes(root, () => {
          Effect.runForkWith(context)(
            reload.pipe(Effect.catch((error) => Effect.logWarning(error.message))),
          );
        }),
      ),
      (close) => Effect.sync(close),
    );
    yield* reload.pipe(Effect.catch((error) => Effect.logWarning(error.message)));
    const setPin = Effect.fn("AgentHomeService.setPin")(function* (
      threadId: ThreadId,
      pinned: boolean,
    ) {
      const shell = yield* threads.getThreadShell(threadId);
      if (!shell || (shell.pinnedAt != null) === pinned) return;
      if (pinned && shell.archivedAt !== null) return;
      yield* threads.dispatch({
        type: pinned ? "thread.pin" : "thread.unpin",
        commandId: CommandId.make(`agent-bind:${yield* crypto.uuidV4()}`),
        threadId,
      });
    });
    const reveal = Effect.fn("AgentHomeService.reveal")(function* (handle: string) {
      const current = (yield* settings.getSettings).sidebarAgents;
      if (!current?.hidden.includes(handle)) return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* settings.updateSettings({
        sidebarAgents: {
          ...current,
          hidden: current.hidden.filter((entry) => entry !== handle),
          updatedAt: DateTime.formatIso(
            DateTime.makeUnsafe(Math.max(now, Date.parse(current.updatedAt) + 1 || 0)),
          ),
        },
      });
    });
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
          const fail = (message: string) => new AgentHomeError({ handle: input.handle, message });
          if (input.office) {
            if (threadId === undefined) return yield* fail("Give the office thread");
            if (home.binding === null) return yield* fail("Bind the main thread before its office");
            if (threadId === home.binding.threadId)
              return yield* fail("The office cannot be the main thread");
            if (
              threadId === null
                ? home.office == null
                : home.office?.threadId === threadId &&
                  (home.office.environmentId === null ||
                    home.office.environmentId === environmentId)
            )
              return { home, changed: false };
            const local = threadId !== null && environmentId === descriptor.environmentId;
            if (threadId !== null && (yield* Effect.promise(() => isLaneThread(root, threadId))))
              return yield* fail("Lane threads cannot be agent offices");
            if (local) {
              const shell = yield* threads
                .getThreadShell(threadId)
                .pipe(Effect.mapError(() => fail("Unable to read the office thread")));
              if (!shell || shell.deletedAt !== null)
                return yield* fail("Office thread does not exist on this environment");
            }
            const officeAt = DateTime.formatIso(yield* DateTime.now).replace(/\.\d{3}Z$/, "Z");
            yield* Effect.tryPromise({
              try: () =>
                writeOffice(
                  root,
                  input.handle,
                  doc,
                  threadId === null
                    ? null
                    : {
                        thread_id: threadId,
                        environment_id: environmentId,
                        host: input.host ?? descriptor.label.toLowerCase(),
                        at: officeAt,
                        by: input.by ?? "t3",
                      },
                  text,
                ),
              catch: (cause) =>
                new AgentHomeError({
                  handle: input.handle,
                  message: "Unable to save agent office",
                  cause,
                }),
            });
            if (local)
              yield* setPin(threadId, false).pipe(
                Effect.catch((error) => Effect.logWarning(error.message)),
              );
            const updated = (yield* reload).homes.find((entry) => entry.handle === input.handle);
            if (!updated) return yield* fail("Agent home disappeared after binding");
            return { home: updated, changed: true };
          }
          if (threadId === undefined)
            return yield* new AgentHomeError({ handle: input.handle, message: "Give a thread" });
          const bindThread =
            !(threadId === null && home.binding === null) &&
            !(input.onlyIfUnbound && home.binding) &&
            !(
              home.binding !== null &&
              home.binding.threadId === threadId &&
              (home.binding.environmentId === null || home.binding.environmentId === environmentId)
            );
          if (!bindThread) return { home, changed: false };
          if (threadId !== null && environmentId === descriptor.environmentId) {
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
                threadId === null
                  ? null
                  : {
                      thread_id: threadId,
                      environment_id: environmentId,
                      host: input.host ?? descriptor.label.toLowerCase(),
                      at,
                      by: input.by ?? "t3",
                    },
                text,
              ),
            catch: (cause) =>
              new AgentHomeError({
                handle: input.handle,
                message: "Unable to save agent binding",
                cause,
              }),
          });
          if (threadId !== null) {
            const previous = home.binding;
            const warn = Effect.catch((error: { readonly message: string }) =>
              Effect.logWarning(error.message),
            );
            if (
              previous !== null &&
              previous.threadId !== threadId &&
              (previous.environmentId === null ||
                previous.environmentId === descriptor.environmentId)
            )
              yield* setPin(previous.threadId, false).pipe(warn);
            if (environmentId === descriptor.environmentId)
              yield* setPin(threadId, true).pipe(warn);
            yield* reveal(input.handle).pipe(warn);
          }
          const snapshot = yield* reload;
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
