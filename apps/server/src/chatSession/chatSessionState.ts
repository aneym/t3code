import type { AuthSessionState, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export class ChatRequestThreads extends Context.Service<
  ChatRequestThreads,
  ReadonlyArray<ThreadId>
>()("t3/chatSession/chatSessionState/ChatRequestThreads") {}

export const withChatThreads = (state: AuthSessionState) =>
  Effect.serviceOption(ChatRequestThreads).pipe(
    Effect.map((threads) =>
      state.authenticated && Option.isSome(threads)
        ? { ...state, chatThreadIds: threads.value }
        : state,
    ),
  );
