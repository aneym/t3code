import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RemoteDelegation from "./RemoteDelegation.ts";
import * as AgentPlacement from "./AgentPlacement.ts";
import * as WorktreeTransfer from "./WorktreeTransfer.ts";

export const layer = Layer.mergeAll(
  RemoteDelegation.layer,
  AgentPlacement.layer,
  WorktreeTransfer.layer,
);

export const start = RemoteDelegation.RemoteDelegation.pipe(
  Effect.flatMap((remote) => remote.start()),
);
