import {
  type DesktopBrowserRemoteEvents,
  type DesktopBrowserRemoteSource,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

type Channel = DesktopBrowserChannel.DesktopBrowserChannel["Service"];

export const provideChannel = (channel: Option.Option<Channel>) =>
  Option.match(channel, {
    onNone: () => Layer.empty,
    onSome: (service) => Layer.succeed(DesktopBrowserChannel.DesktopBrowserChannel, service),
  });

export const handlers = (channel: Channel | undefined, sessionId: string) => ({
  [WS_METHODS.desktopBrowserCommands]: (input: DesktopBrowserRemoteSource) =>
    Stream.unwrap(
      (channel?.remoteCommands?.(input, sessionId) ?? Effect.succeed(Stream.empty)).pipe(
        Effect.map((stream) => stream.pipe(Stream.map((line) => line.trimEnd()))),
      ),
    ),
  [WS_METHODS.desktopBrowserEvents]: (input: DesktopBrowserRemoteEvents) =>
    channel?.remoteEvents?.(input, sessionId) ?? Effect.void,
});
