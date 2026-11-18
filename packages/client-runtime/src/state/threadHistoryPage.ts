import {
  CHAT_SESSION_HISTORY_PAGE_BYTES,
  ORCHESTRATION_V2_WS_METHODS,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { chatSessionActive } from "../chatSession.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { getInitialServerConfig, request } from "../rpc/client.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import type { ThreadHistoryMeta } from "./threadHistoryMerge.ts";

const CHAT_SESSION_PAGES_PER_TRIGGER = 4;

export const servesSocketHistory = (config: Option.Option<ServerConfig>) =>
  !chatSessionActive() ||
  Option.exists(config, (value) => value.environment.capabilities.threadHistoryRpc === true);

export const historyPagingAvailable = (supervisor: EnvironmentSupervisor["Service"]) =>
  chatSessionActive()
    ? getInitialServerConfig().pipe(
        Effect.map((config) => servesSocketHistory(Option.some(config))),
        Effect.orElseSucceed(() => false),
        Effect.provideService(EnvironmentSupervisor, supervisor),
      )
    : Effect.succeed(true);

export const resumable = <S extends { readonly state: { readonly history: ThreadHistoryMeta } }>(
  snapshot: S,
): S | undefined => (snapshot.state.history.expanded && chatSessionActive() ? undefined : snapshot);

export const historyPagesPerTrigger = () =>
  chatSessionActive() ? CHAT_SESSION_PAGES_PER_TRIGGER : Number.POSITIVE_INFINITY;

export const fetchThreadHistoryPage = Effect.fn("clientRuntime.state.fetchThreadHistoryPage")(
  function* (
    input: Parameters<typeof fetchEnvironmentThreadHistoryPage>[0] & {
      readonly view?: "conversation" | "work" | undefined;
      readonly supervisor: EnvironmentSupervisor["Service"];
    },
  ) {
    if (!chatSessionActive()) return yield* fetchEnvironmentThreadHistoryPage(input);
    return yield* request(ORCHESTRATION_V2_WS_METHODS.getThreadHistoryPage, {
      threadId: input.threadId,
      cursor: input.cursor,
      maxBytes: CHAT_SESSION_HISTORY_PAGE_BYTES,
      compactIds: true,
      ...(input.throughEntryId === undefined
        ? { deferWork: true }
        : { throughEntryId: input.throughEntryId }),
      ...(input.view === undefined ? {} : { view: input.view }),
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.provideService(EnvironmentSupervisor, input.supervisor),
    );
  },
);
