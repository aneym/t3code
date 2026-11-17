import { DesktopRailsWordsSaid, DesktopRailsWordsState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as RailsWords from "../../railsWords/RailsWords.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getRailsWordsState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RAILS_WORDS_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopRailsWordsState,
  handler: Effect.fn("desktop.ipc.railsWords.getState")(function* () {
    return yield* (yield* RailsWords.RailsWords).getState;
  }),
});

export const railsWordsSaid = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RAILS_WORDS_SAID_CHANNEL,
  payload: DesktopRailsWordsSaid,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.railsWords.said")(function* (input) {
    yield* (yield* RailsWords.RailsWords).said(input);
  }),
});

export const disconnectRailsWords = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RAILS_WORDS_DISCONNECT_CHANNEL,
  payload: Schema.Void,
  result: DesktopRailsWordsState,
  handler: Effect.fn("desktop.ipc.railsWords.disconnect")(function* () {
    return yield* (yield* RailsWords.RailsWords).disconnect;
  }),
});
