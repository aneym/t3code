import type { ProviderDriverKind, ProviderInstallState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export class CliInstallationError extends Schema.TaggedError<CliInstallationError>()(
  "CliInstallationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const cliInstallationError = (operation: string, detail: string, cause?: unknown) =>
  new CliInstallationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

export interface InstalledCli {
  readonly executablePath: string;
  readonly version: string;
}

export type CliInstallUpdate = (patch: Partial<ProviderInstallState>) => Effect.Effect<void>;

export interface CliInstallRunner {
  readonly start: Effect.Effect<ProviderInstallState, CliInstallationError>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, CliInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  readonly remove: (
    protectedBinaryPaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void, CliInstallationError>;
}

const isRunning = (state: ProviderInstallState) =>
  state.phase === "downloading" || state.phase === "extracting" || state.phase === "verifying";

export const makeCliInstallRunner = Effect.fn("makeCliInstallRunner")(function* (options: {
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly findInstalled: Effect.Effect<InstalledCli | null>;
  readonly install: (
    update: CliInstallUpdate,
  ) => Effect.Effect<InstalledCli, CliInstallationError, Scope.Scope>;
}) {
  const serviceScope = yield* Effect.scope;
  const crypto = yield* SecureRandom.SecureRandom;
  const gate = yield* Semaphore.make(1);
  let running: { readonly operationId: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: options.driver,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion: null,
    executablePath: null,
    source: null,
    canRemove: false,
    message: null,
  });
  const installed = (cli: InstalledCli, message: string | null) =>
    ({
      phase: "succeeded",
      source: "local",
      version: cli.version,
      installedVersion: cli.version,
      executablePath: cli.executablePath,
      message,
    }) satisfies Partial<ProviderInstallState>;

  const start = gate.withPermit(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      if (isRunning(current)) return current;
      const existing = yield* options.findInstalled;
      if (existing) {
        yield* SubscriptionRef.update(state, ({ download: _download, ...value }) => ({
          ...value,
          ...installed(existing, `${options.displayName} is already installed.`),
          operationId: null,
          downloadedBytes: 0,
          totalBytes: null,
        }));
        return yield* SubscriptionRef.get(state);
      }
      const operationId = yield* crypto
        .uuidV4()
        .pipe(
          Effect.mapError(() =>
            cliInstallationError("start", `Could not start installing ${options.displayName}.`),
          ),
        );
      const { download: _download, ...rest } = current;
      const next: ProviderInstallState = {
        ...rest,
        operationId,
        phase: "downloading",
        downloadedBytes: 0,
        totalBytes: null,
        version: null,
        message: `Downloading ${options.displayName}.`,
      };
      yield* SubscriptionRef.set(state, next);
      const update: CliInstallUpdate = (patch) =>
        SubscriptionRef.update(state, (value) =>
          value.operationId === operationId ? { ...value, ...patch } : value,
        );
      const work = options.install(update).pipe(
        Effect.scoped,
        Effect.flatMap((cli) => update(installed(cli, `${options.displayName} is installed.`))),
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Effect.void;
          const cancelled = Cause.hasInterruptsOnly(exit.cause);
          const error = Cause.findErrorOption(exit.cause);
          return update({
            phase: cancelled ? "cancelled" : "failed",
            message: cancelled
              ? "Installation cancelled."
              : Option.isSome(error)
                ? error.value.detail
                : `Could not install ${options.displayName}.`,
          });
        }),
        Effect.ignoreCause,
        Effect.ensuring(
          Effect.sync(() => {
            if (running?.operationId === operationId) running = undefined;
          }),
        ),
      );
      const fiber = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
      running = { operationId, fiber };
      return next;
    }).pipe(Effect.uninterruptible),
  );

  const cancel = Effect.fn("CliInstallRunner.cancel")(function* (operationId: string) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.operationId !== operationId)
          return yield* cliInstallationError(
            "cancel",
            "This installation is no longer current. Refresh its status before cancelling.",
          );
        if (running?.operationId === operationId && isRunning(current))
          yield* Fiber.interrupt(running.fiber);
        return yield* SubscriptionRef.get(state);
      }),
    );
  });

  const remove = () =>
    Effect.fail(
      cliInstallationError(
        "remove-install",
        `${options.displayName} belongs to its own installer and is not removed here.`,
      ),
    );

  return {
    start,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    remove,
  } satisfies CliInstallRunner;
});
