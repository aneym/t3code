import {
  AuthOrchestrationOperateScope,
  type AuthSessionId,
  SPEECH_STREAM_PATH,
  SPEECH_STREAM_MAX_CHUNK_BYTES,
  SpeechStreamCommand,
  SPEECH_MAX_OPTIONS_BYTES,
  type SpeechStreamEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ChatDictation from "../chatSession/ChatDictation.ts";
import { requestUrl } from "../requestUrl.ts";
import * as SpeechService from "./SpeechService.ts";

const isRefusal = Schema.is(ChatDictation.ChatDictationRefusedError);
const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(SpeechStreamCommand));

/** One socket owns one stream. Audio is processed and acknowledged in arrival order. */
type StreamOptions = Parameters<SpeechService.SpeechService["Service"]["startStream"]>[0];
type StreamError = SpeechService.SpeechError | ChatDictation.ChatDictationRefusedError;
type SpeechStarter = {
  readonly startStream: (options: StreamOptions) => Effect.Effect<
    {
      readonly feed: (
        pcm: Uint8Array,
      ) => Effect.Effect<
        Effect.Success<ReturnType<SpeechService.SpeechStream["feed"]>>,
        StreamError
      >;
      readonly finish: SpeechService.SpeechStream["finish"];
    },
    StreamError,
    Scope.Scope
  >;
};

export const runSpeechSocket = Effect.fn("speech.runSocket")(function* (
  socket: Socket.Socket,
  speech: SpeechStarter,
) {
  const scope = yield* Scope.Scope;
  const writer = yield* socket.writer;
  const send = (event: SpeechStreamEvent) => writer.write(JSON.stringify(event));
  let stream: Effect.Success<ReturnType<SpeechStarter["startStream"]>> | undefined;
  let ended = false;
  const fail = Effect.fn("speech.failSocket")(function* (message: string) {
    if (ended) return;
    ended = true;
    yield* send({ type: "error", message });
    yield* writer.write(new Socket.CloseEvent(1008, "Speech stream ended"));
  });
  const receive = (data: string | Uint8Array) => {
    if (ended) return Effect.void;
    return Effect.gen(function* () {
      if (typeof data === "string") {
        if (new TextEncoder().encode(data).byteLength > SPEECH_MAX_OPTIONS_BYTES)
          return yield* fail("Invalid speech stream command.");
        const command = yield* decodeCommand(data);
        if (command.type === "start") {
          if (stream) return yield* fail("Speech stream already started.");
          stream = yield* speech.startStream(command.options).pipe(Scope.provide(scope));
          yield* send({ type: "ready" });
          return;
        }
        if (!stream) return yield* fail("Start speech transcription before finishing.");
        const text = yield* stream.finish;
        ended = true;
        yield* send({ type: "finished", text });
        yield* writer.write(new Socket.CloseEvent(1000));
      } else {
        if (data.byteLength > SPEECH_STREAM_MAX_CHUNK_BYTES)
          return yield* fail("Speech audio chunk is too large.");
        if (!stream) return yield* fail("Start speech transcription before sending audio.");
        const update = yield* stream.feed(data);
        yield* send({ type: "update", ...update });
      }
    }).pipe(
      Effect.catch((cause) =>
        isRefusal(cause)
          ? fail(cause.message)
          : Effect.logError("live transcription operation failed", { cause }).pipe(
              Effect.andThen(fail("Live transcription failed. Please try recording again.")),
            ),
      ),
    );
  };
  const reader = yield* socket.reader;
  yield* Effect.gen(function* () {
    const pending = yield* Queue.bounded<string | Uint8Array>(2);
    yield* Effect.forever(Queue.take(pending).pipe(Effect.flatMap(receive))).pipe(
      Effect.forkScoped,
    );
    while (true) {
      const frames = yield* reader.pull;
      yield* Effect.forEach(frames, (frame) => Queue.offer(pending, frame), {
        discard: true,
      });
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 minutes",
      // The socket read loop is already interrupted here; its writer can no longer send.
      orElse: () => Effect.void,
    }),
    Effect.ignore,
  );
});

const meteredSpeech = (
  speech: SpeechService.SpeechService["Service"],
  dictation: ChatDictation.ChatDictation["Service"],
  session: ChatDictation.ChatDictationSession,
): SpeechStarter => ({
  startStream: Effect.fn("speech.startChatStream")(function* (options: StreamOptions) {
    yield* dictation.admit(session, 0);
    const stream = yield* speech.startStream(options);
    return {
      ...stream,
      feed: Effect.fnUntraced(function* (pcm: Uint8Array) {
        yield* dictation.charge(session, pcm.byteLength);
        if (!(yield* dictation.qualifies(session))) return yield* ChatDictation.refuse("not_owner");
        return yield* stream.feed(pcm);
      }),
    };
  }),
});

const voiceTicket = (request: HttpServerRequest.HttpServerRequest) =>
  Option.flatMap(requestUrl(request), (url) =>
    Option.fromNullishOr(url.searchParams.get("wsTicket")),
  );

export const speechStreamRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const storedSessions = yield* AuthSessions.AuthSessionRepository;
    const speech = yield* SpeechService.SpeechService;
    const dictation = yield* ChatDictation.ChatDictation;
    const authenticate = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const ticket = voiceTicket(request);
      const redeemed = Option.isSome(ticket)
        ? yield* dictation.redeemVoiceTicket(ticket.value)
        : Option.none();
      if (Option.isSome(redeemed)) return { session: redeemed.value, status: 0 };
      const session = yield* auth
        .authenticateWebSocketUpgrade(request, "media")
        .pipe(Effect.option);
      if (Option.isNone(session)) return { session: undefined, status: 401 };
      return session.value.scopes.includes(AuthOrchestrationOperateScope)
        ? { session: session.value, status: 0 }
        : { session: undefined, status: 403 };
    });
    const isLive = (sessionId: AuthSessionId) =>
      Effect.all([storedSessions.getById({ sessionId }), DateTime.now]).pipe(
        Effect.map(
          ([row, now]) =>
            Option.isSome(row) &&
            row.value.revokedAt === null &&
            DateTime.isGreaterThan(row.value.expiresAt, now),
        ),
        Effect.orElseSucceed(() => false),
      );
    return HttpRouter.add(
      "GET",
      SPEECH_STREAM_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { session, status } = yield* authenticate(request);
        if (session === undefined) return HttpServerResponse.empty({ status });
        const chat = ChatDictation.isChatPrincipal(session.scopes);
        if (!chat) {
          const socket = yield* request.upgrade;
          yield* runSpeechSocket(socket, speech).pipe(Effect.scoped);
          return HttpServerResponse.empty();
        }
        if (!(yield* isLive(session.sessionId)) || !(yield* dictation.qualifies(session)))
          return HttpServerResponse.empty({ status: 403 });
        const socket = yield* request.upgrade;
        yield* Effect.raceFirst(
          runSpeechSocket(socket, meteredSpeech(speech, dictation, session)).pipe(Effect.scoped),
          sessions.awaitInvalidation(session.sessionId).pipe(Effect.ignore),
        );
        return HttpServerResponse.empty();
      }),
    );
  }),
);
