import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { EmbedPaintSource } from "@t3tools/contracts";
import * as Option from "effect/Option";

export function embedPaintSource(firstState: EnvironmentThreadState): EmbedPaintSource {
  if (Option.isNone(firstState.data)) return "live";
  return firstState.status === "live" ? "memory" : "kept";
}
