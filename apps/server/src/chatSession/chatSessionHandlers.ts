// @effect-diagnostics unsafeEffectTypeAssertion:off anyUnknownInErrorContext:off -- handler results arrive untyped through the handler table, which re-types them.
import {
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  type ThreadId,
  type WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import type { ChatSessionContext } from "./ChatSessionAccess.ts";
import { rebuildChatCommand } from "./chatSessionCommands.ts";
import {
  chatLifecycleEvent,
  chatServerConfig,
  chatServerConfigEvent,
  makeChatShellFilter,
} from "./chatSessionViews.ts";

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>;

const O = ORCHESTRATION_V2_WS_METHODS;
const W = WS_METHODS;

type Overridden =
  | typeof O.dispatchCommand
  | typeof O.subscribeShell
  | typeof O.getThreadTitles
  | typeof O.getThreadLinkMetadata
  | typeof O.getThreadFamily
  | typeof W.serverGetConfig
  | typeof W.subscribeServerConfig
  | typeof W.subscribeServerLifecycle
  | typeof W.assetsCreateUrl
  | typeof W.attachmentsCreateUploadUrl;

type ChatHandlers = Pick<Handlers, Overridden>;

const unwrap = (result: object): unknown => (Rpc.isWrapper(result) ? result.value : result);

const mapStream = <A>(result: object, f: (item: A) => A | undefined) => {
  const value = unwrap(result);
  return Stream.isStream(value)
    ? (value as Stream.Stream<A>).pipe(
        Stream.map(f),
        Stream.filter((item): item is A => item !== undefined),
      )
    : Stream.die(new Error("A chat session stream handler returned no stream."));
};

const mapEffect = <A, B>(result: object, f: (value: A) => Effect.Effect<B>) => {
  const value = unwrap(result);
  return Effect.isEffect(value)
    ? (value as Effect.Effect<A>).pipe(Effect.flatMap(f))
    : Effect.die(new Error("A chat session handler returned no effect."));
};

export function chatSessionHandlers<H extends ChatHandlers>(
  handlers: H,
  chat: ChatSessionContext | undefined,
): H {
  if (chat === undefined) return handlers;
  const { access, grants } = chat;
  const { setId, threads } = access.session;
  const overrides: {
    readonly [K in Overridden]: (
      payload: Parameters<Handlers[K]>[0],
      options: Parameters<Handlers[K]>[1],
    ) => unknown;
  } = {
    [O.dispatchCommand]: (command, options) =>
      handlers[O.dispatchCommand](rebuildChatCommand(command), options),
    [O.subscribeShell]: (input, options) => {
      const filter = makeChatShellFilter(threads);
      return mapStream(
        handlers[O.subscribeShell](
          {
            ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
            ...(input.requestCompletionMarker === undefined
              ? {}
              : { requestCompletionMarker: input.requestCompletionMarker }),
          },
          options,
        ),
        filter.apply,
      );
    },
    [O.getThreadTitles]: (input, options) =>
      handlers[O.getThreadTitles]({ threadIds: input.threadIds.filter(access.inSet) }, options),
    [O.getThreadLinkMetadata]: (input, options) =>
      handlers[O.getThreadLinkMetadata](
        { threadIds: input.threadIds.filter(access.inSet) },
        options,
      ),
    [O.getThreadFamily]: (input, options) =>
      mapEffect(
        handlers[O.getThreadFamily]({ threadId: input.threadId }, options),
        (family: {
          readonly snapshotSequence: number;
          readonly threads: ReadonlyArray<{ readonly id: ThreadId }>;
        }) =>
          Effect.succeed({
            snapshotSequence: family.snapshotSequence,
            threads: family.threads.filter((thread) => access.inSet(thread.id)),
          }),
      ),
    [W.serverGetConfig]: (input, options) =>
      mapEffect(
        handlers[W.serverGetConfig](input, options),
        (config: Parameters<typeof chatServerConfig>[0]) =>
          Effect.succeed(chatServerConfig(config)),
      ),
    [W.subscribeServerConfig]: (_input, options) =>
      mapStream(handlers[W.subscribeServerConfig]({}, options), chatServerConfigEvent),
    [W.subscribeServerLifecycle]: (input, options) =>
      mapStream(handlers[W.subscribeServerLifecycle](input, options), chatLifecycleEvent),
    [W.assetsCreateUrl]: (input, options) =>
      mapEffect(
        handlers[W.assetsCreateUrl]({ resource: input.resource }, options),
        (result: { readonly relativeUrl: string; readonly expiresAt: number }) =>
          grants.recordUrl(setId, result.relativeUrl, result.expiresAt).pipe(Effect.as(result)),
      ),
    [W.attachmentsCreateUploadUrl]: (input, options) =>
      mapEffect(
        handlers[W.attachmentsCreateUploadUrl](input, options),
        (result: {
          readonly attachmentId: string;
          readonly relativeUrl: string;
          readonly expiresAt: number;
        }) =>
          grants
            .recordUpload(setId, result.attachmentId, result.relativeUrl, result.expiresAt)
            .pipe(Effect.as(result)),
      ),
  };
  return { ...handlers, ...overrides } as H;
}
