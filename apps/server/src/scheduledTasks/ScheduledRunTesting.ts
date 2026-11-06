import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScheduledRunStart from "./ScheduledRunStart.ts";
import * as ScheduledRunWorkspace from "./ScheduledRunWorkspace.ts";

export const layerPassthrough = Layer.mergeAll(
  Layer.mock(ScheduledRunWorkspace.ScheduledRunWorkspace)({
    resolve: (task) => Effect.succeed(task.workspaceStrategy),
  }),
  Layer.mock(ScheduledRunStart.ScheduledRunStart)({
    watch: () => Effect.void,
    recover: () => Effect.void,
  }),
);
