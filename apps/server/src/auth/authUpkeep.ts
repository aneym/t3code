import * as Layer from "effect/Layer";

import * as AuthSessionRetention from "./authSessionRetention.ts";
import * as ReplayMarkers from "./replayMarkers.ts";

export const layer = Layer.mergeAll(ReplayMarkers.layer, AuthSessionRetention.layer);
