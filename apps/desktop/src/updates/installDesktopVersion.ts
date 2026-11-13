import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

class DesktopVersionInstallError extends Schema.TaggedError<DesktopVersionInstallError>()(
  "DesktopVersionInstallError",
  { message: Schema.String },
) {}

interface VersionInstaller {
  readonly getState: Effect.Effect<DesktopUpdateState>;
  readonly stateChanges: PubSub.PubSub<DesktopUpdateState>;
  readonly stateLock: Semaphore.Semaphore;
  readonly platform: string;
  readonly quitting: Effect.Effect<boolean>;
  readonly configured: Effect.Effect<boolean>;
  readonly reserve: Effect.Effect<boolean>;
  readonly release: Effect.Effect<void>;
  readonly feedConfig: Effect.Effect<Option.Option<Readonly<Record<string, string>>>>;
  readonly setFeed: (url: string) => Effect.Effect<void>;
  readonly check: Effect.Effect<boolean>;
  readonly download: Effect.Effect<{ readonly completed: boolean }>;
  readonly install: (version: string) => Effect.Effect<DesktopUpdateActionResult>;
  readonly updateState: (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ) => Effect.Effect<DesktopUpdateState>;
  readonly now: Effect.Effect<string>;
}

function failureMessage(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "cause" in cause) {
    return failureMessage(cause.cause);
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export function makeVersionInstaller(input: VersionInstaller) {
  const fail = (message: string) =>
    input.now.pipe(
      Effect.flatMap((checkedAt) =>
        input.updateState((state) => ({
          ...state,
          status: "error",
          message,
          checkedAt,
          downloadPercent: null,
          errorContext: "check",
          canRetry: false,
        })),
      ),
    );
  return Effect.fn("DesktopUpdates.installVersion")(function* (version: string) {
    const refused = Effect.map(input.getState, (state) => ({
      accepted: false,
      completed: false,
      state,
    }));
    if (
      input.platform !== "darwin" ||
      (yield* input.quitting) ||
      !(yield* input.configured) ||
      !(yield* input.reserve)
    )
      return yield* refused;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const initial = yield* input.getState;
        const feedConfig = Option.getOrUndefined(yield* input.feedConfig);
        const root = feedConfig?.provider === "generic" ? feedConfig.url : undefined;
        if (!/^\d+\.\d+\.\d+-nightly\.[0-9A-Za-z.-]+\.aneym\.\d+$/.test(version)) {
          return yield* new DesktopVersionInstallError({
            message: "Select an exact fork desktop version.",
          });
        }
        if (!root || initial.channel !== "nightly") {
          return yield* new DesktopVersionInstallError({
            message: "Fork desktop switching requires a generic nightly feed.",
          });
        }
        if (version === initial.currentVersion) return yield* refused;
        const feed = new URL(root.endsWith("/") ? root : `${root}/`);
        if (feed.protocol !== "https:" && feed.protocol !== "http:") {
          return yield* new DesktopVersionInstallError({
            message: "The desktop feed must use HTTP or HTTPS.",
          });
        }
        const changes = Stream.fromSubscription(
          yield* input.stateLock.withPermits(1)(PubSub.subscribe(input.stateChanges)),
        );
        const awaitState = Effect.fn("DesktopUpdates.awaitVersionState")(function* (
          predicate: (state: DesktopUpdateState) => boolean,
        ) {
          const state = yield* input.getState;
          if (predicate(state)) return state;
          const next = yield* changes.pipe(
            Stream.filter(predicate),
            Stream.runHead,
            Effect.timeout("15 minutes"),
          );
          if (Option.isNone(next))
            return yield* new DesktopVersionInstallError({
              message: "Desktop update ended without a result.",
            });
          return next.value;
        });
        yield* input.setFeed(new URL(`desktop/${encodeURIComponent(version)}/`, feed).href);
        const run = Effect.gen(function* () {
          if (!(yield* input.check)) return yield* refused;
          const checked = yield* awaitState((state) => state.status !== "checking");
          if (checked.status === "error")
            return yield* new DesktopVersionInstallError({
              message: checked.message ?? "Desktop update check failed.",
            });
          if (checked.status !== "available" || checked.availableVersion !== version) {
            return yield* new DesktopVersionInstallError({
              message: `The desktop feed did not offer ${version}.`,
            });
          }
          if (!(yield* input.download).completed) return yield* refused;
          const downloaded = yield* awaitState(
            (state) => state.status === "downloaded" || state.status === "error",
          );
          if (downloaded.status === "error")
            return yield* new DesktopVersionInstallError({
              message: downloaded.message ?? "Desktop download failed.",
            });
          if (downloaded.downloadedVersion !== version)
            return yield* new DesktopVersionInstallError({
              message: "The downloaded desktop version did not match the selection.",
            });
          return yield* input.install(version);
        });
        return yield* run.pipe(Effect.ensuring(input.setFeed(feed.href)));
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        fail(failureMessage(Cause.squash(cause))).pipe(Effect.andThen(refused)),
      ),
      Effect.ensuring(input.release),
    );
  });
}
