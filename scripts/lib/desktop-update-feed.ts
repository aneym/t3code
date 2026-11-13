import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

type UpdateChannel = "latest" | "nightly";

export const withDesktopUpdateFeed = Effect.fn("withDesktopUpdateFeed")(function* <Fallback, E, R>(
  updateChannel: UpdateChannel,
  fallback: (updateChannel: UpdateChannel) => Effect.Effect<Fallback, E, R>,
) {
  const updateUrl = Option.getOrUndefined(
    yield* Config.String("T3CODE_DESKTOP_UPDATE_URL").pipe(Config.option),
  )?.trim();
  if (!updateUrl) return yield* fallback(updateChannel);
  return {
    provider: "generic" as const,
    url: updateUrl,
    ...(updateChannel === "nightly" ? { channel: "nightly" as const } : {}),
  };
});
