import type { ServerConfig } from "@t3tools/contracts";
import type * as Option from "effect/Option";

import { servesSocketHistory } from "./threadHistoryPage.ts";

export function threadSubscribeAccepts(
  acceptBoundedSnapshot: boolean,
  config: Option.Option<ServerConfig>,
) {
  if (!acceptBoundedSnapshot) return {};
  return {
    acceptBoundedSnapshot: true as const,
    ...(servesSocketHistory(config) ? { acceptDeferredWork: true as const } : {}),
    acceptCompactTurnItems: true as const,
    acceptCompactIds: true as const,
  };
}
