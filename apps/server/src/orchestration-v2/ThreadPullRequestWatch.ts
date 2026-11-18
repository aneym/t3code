import type { ThreadPullRequestLink, ThreadPullRequestWatch } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function withPullRequestWatch(
  link: ThreadPullRequestLink,
  watch: ThreadPullRequestWatch | undefined,
): ThreadPullRequestLink {
  const { watch: previous, endedWatch, ...rest } = link;
  if (watch !== undefined) return { ...rest, watch };
  const ended = previous ?? endedWatch;
  return ended === undefined ? rest : { ...rest, endedWatch: ended };
}

export function pullRequestSnapshotEndsWatch(
  snapshot: ThreadPullRequestLink["snapshot"],
  watchStartedAt: ThreadPullRequestWatch["startedAt"],
): boolean {
  return (
    snapshot?.state === "merged" ||
    (snapshot?.state === "closed" &&
      DateTime.isGreaterThanOrEqualTo(
        DateTime.makeUnsafe(snapshot.syncedAt),
        DateTime.makeUnsafe(watchStartedAt),
      ))
  );
}
