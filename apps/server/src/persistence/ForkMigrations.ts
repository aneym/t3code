import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";

import CompletionDeliveryIndexes from "./ForkMigrations/001_CompletionDeliveryIndexes.ts";
import ProjectionThreadAutomationPlacement from "./ForkMigrations/002_ProjectionThreadAutomationPlacement.ts";
import ProjectionProjectsPinOrder from "./ForkMigrations/003_ProjectionProjectsPinOrder.ts";

import ChildSettlementIndexes from "./ForkMigrations/004_ChildSettlementIndexes.ts";
import RemoveUnusedEventCorrelationIndex from "./ForkMigrations/005_RemoveUnusedEventCorrelationIndex.ts";

import ProjectPinOrderToPinnedAt from "./ForkMigrations/006_ProjectPinOrderToPinnedAt.ts";
import McpEventsSubscriptions from "./ForkMigrations/007_McpEventsSubscriptions.ts";
import HostLinkLanes from "./ForkMigrations/008_HostLinkLanes.ts";
import ThreadPlacements from "./ForkMigrations/009_ThreadPlacements.ts";
import TurnItemTimelineCoverIndex from "./ForkMigrations/010_TurnItemTimelineCoverIndex.ts";
import BridgedMessageSearch from "./ForkMigrations/011_BridgedMessageSearch.ts";
import PeerLinkRenewal from "./ForkMigrations/012_PeerLinkRenewal.ts";
import CommandReadIndexes from "./ForkMigrations/013_CommandReadIndexes.ts";

const run = Migrator.make({});
const loader = Migrator.fromRecord({
  "1_CompletionDeliveryIndexes": CompletionDeliveryIndexes,
  "2_ProjectionThreadAutomationPlacement": ProjectionThreadAutomationPlacement,
  "3_ProjectionProjectsPinOrder": ProjectionProjectsPinOrder,
  "4_ChildSettlementIndexes": ChildSettlementIndexes,
  "5_RemoveUnusedEventCorrelationIndex": RemoveUnusedEventCorrelationIndex,
  "6_ProjectPinOrderToPinnedAt": ProjectPinOrderToPinnedAt,
  "7_McpEventsSubscriptions": McpEventsSubscriptions,
  "8_HostLinkLanes": HostLinkLanes,
  "9_ThreadPlacements": ThreadPlacements,
  "10_TurnItemTimelineCoverIndex": TurnItemTimelineCoverIndex,
  "11_BridgedMessageSearch": BridgedMessageSearch,
  "12_PeerLinkRenewal": PeerLinkRenewal,
  "13_CommandReadIndexes": CommandReadIndexes,
});

export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* run({ loader, table: "aneym_fork_migrations" });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
});
