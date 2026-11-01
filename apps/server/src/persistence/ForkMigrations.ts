import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";

import CompletionDeliveryIndexes from "./ForkMigrations/001_CompletionDeliveryIndexes.ts";
import ProjectionThreadAutomationPlacement from "./ForkMigrations/002_ProjectionThreadAutomationPlacement.ts";
import ProjectionProjectsPinOrder from "./ForkMigrations/003_ProjectionProjectsPinOrder.ts";

import ChildSettlementIndexes from "./ForkMigrations/004_ChildSettlementIndexes.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord({
  "1_CompletionDeliveryIndexes": CompletionDeliveryIndexes,
  "2_ProjectionThreadAutomationPlacement": ProjectionThreadAutomationPlacement,
  "3_ProjectionProjectsPinOrder": ProjectionProjectsPinOrder,
  "4_ChildSettlementIndexes": ChildSettlementIndexes,
});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* run({ loader, table: "aneym_fork_migrations" });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
});
