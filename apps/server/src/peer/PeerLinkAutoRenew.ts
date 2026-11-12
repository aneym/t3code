import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { forkParked } from "../serverActivation.ts";
import * as PeerLinks from "./PeerLinks.ts";

const SWEEP_STARTUP_DELAY = Duration.seconds(30);
const SWEEP_INTERVAL = Duration.hours(1);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const links = yield* PeerLinks.PeerLinks;
    yield* forkParked(
      Effect.sleep(SWEEP_STARTUP_DELAY).pipe(
        Effect.andThen(links.renewDue.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)))),
      ),
    );
  }),
);
