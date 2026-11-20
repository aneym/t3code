import {
  CHAT_DICTATION_BUDGET_MINUTES,
  CHAT_DICTATION_REFUSALS,
  isChatSessionScopes,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type AuthWebSocketTicketResult,
  type AuthWebSocketTicketUse,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ChatThreadSets from "./ChatThreadSets.ts";

const AUDIO_BYTES_PER_SECOND = 16_000 * Float32Array.BYTES_PER_ELEMENT;
const CHAT_DICTATION_BUDGET_SECONDS = CHAT_DICTATION_BUDGET_MINUTES * 60;
const BUDGET_BYTES = CHAT_DICTATION_BUDGET_SECONDS * AUDIO_BYTES_PER_SECOND;
const BUCKET_MS = 15 * 60_000;
const BUDGET_BUCKETS = (24 * 60 * 60_000) / BUCKET_MS;
const VOICE_TICKET_TTL_MS = 30_000;

export class ChatDictationRefusedError extends Schema.TaggedError<ChatDictationRefusedError>()(
  "ChatDictationRefusedError",
  {
    reason: Schema.Literals(["not_owner", "dictation_busy", "dictation_limit"]),
    message: Schema.String,
  },
) {}

export const refuse = (reason: keyof typeof CHAT_DICTATION_REFUSALS) =>
  new ChatDictationRefusedError({ reason, message: CHAT_DICTATION_REFUSALS[reason] });

export interface ChatDictationSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly scopes: Iterable<AuthEnvironmentScope>;
}

export interface VoiceTicketSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export const isChatPrincipal = (scopes: Iterable<AuthEnvironmentScope>) =>
  isChatSessionScopes([...scopes]);

export class ChatDictation extends Context.Service<
  ChatDictation,
  {
    readonly qualifies: (session: ChatDictationSession) => Effect.Effect<boolean>;
    readonly admit: (
      session: ChatDictationSession,
      audioBytes: number,
    ) => Effect.Effect<void, ChatDictationRefusedError, Scope.Scope>;
    readonly charge: (
      session: ChatDictationSession,
      audioBytes: number,
    ) => Effect.Effect<void, ChatDictationRefusedError>;
    readonly issueVoiceTicket: (
      session: ChatDictationSession,
      use: AuthWebSocketTicketUse,
    ) => Effect.Effect<AuthWebSocketTicketResult, ChatDictationRefusedError>;
    readonly redeemVoiceTicket: (
      ticket: string,
    ) => Effect.Effect<Option.Option<VoiceTicketSession>>;
  }
>()("t3/chatSession/ChatDictation") {}

const make = Effect.gen(function* () {
  const sets = yield* ChatThreadSets.ChatThreadSets;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const random = yield* SecureRandom.SecureRandom;
  const inFlight = new Set<string>();
  const usage = new Map<string, { total: number; readonly buckets: Map<number, number> }>();
  let sweptBucket = 0;
  const tickets = new Map<string, VoiceTicketSession & { readonly expiresAt: number }>();

  const qualifies = Effect.fn("ChatDictation.qualifies")(function* (session: ChatDictationSession) {
    const scopes = [...session.scopes];
    if (!isChatSessionScopes(scopes)) return false;
    const chat = yield* sets
      .forSession({ subject: session.subject, scopes })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (chat === undefined || chat.ownerThreads.size === 0) return false;
    const live = yield* projections
      .getThreadTitles([...chat.ownerThreads])
      .pipe(Effect.orElseSucceed(() => ({})));
    return Object.keys(live).length > 0;
  });

  const requireOwner = (session: ChatDictationSession) =>
    qualifies(session).pipe(
      Effect.flatMap((owner) => (owner ? Effect.void : Effect.fail(refuse("not_owner")))),
    );

  const charge = Effect.fn("ChatDictation.charge")(function* (
    session: ChatDictationSession,
    audioBytes: number,
  ) {
    const bucket = Math.floor((yield* Clock.currentTimeMillis) / BUCKET_MS);
    if (bucket !== sweptBucket) {
      sweptBucket = bucket;
      for (const [subject, ledger] of usage) {
        for (const [start, bytes] of ledger.buckets) {
          if (start > bucket - BUDGET_BUCKETS) continue;
          ledger.buckets.delete(start);
          ledger.total -= bytes;
        }
        if (ledger.buckets.size === 0) usage.delete(subject);
      }
    }
    const ledger = usage.get(session.subject) ?? { total: 0, buckets: new Map<number, number>() };
    if (ledger.total + audioBytes > BUDGET_BYTES) return yield* refuse("dictation_limit");
    if (audioBytes === 0) return;
    ledger.buckets.set(bucket, (ledger.buckets.get(bucket) ?? 0) + audioBytes);
    ledger.total += audioBytes;
    usage.set(session.subject, ledger);
  });

  const holdSlot = (session: ChatDictationSession) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        if (inFlight.has(session.subject)) return Effect.fail(refuse("dictation_busy"));
        inFlight.add(session.subject);
        return Effect.void;
      }),
      () => Effect.sync(() => inFlight.delete(session.subject)),
    );

  const admit = Effect.fn("ChatDictation.admit")(function* (
    session: ChatDictationSession,
    audioBytes: number,
  ) {
    yield* requireOwner(session);
    yield* holdSlot(session);
    yield* charge(session, audioBytes);
  });

  const issueVoiceTicket = Effect.fn("ChatDictation.issueVoiceTicket")(function* (
    session: ChatDictationSession,
    use: AuthWebSocketTicketUse,
  ) {
    if (use !== "media") return yield* refuse("not_owner");
    yield* requireOwner(session);
    const now = yield* Clock.currentTimeMillis;
    for (const [key, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(key);
    const ticket = Base64Url.encode(yield* random.randomBytes(32).pipe(Effect.orDie));
    const expiresAt = now + VOICE_TICKET_TTL_MS;
    tickets.set(ticket, {
      sessionId: session.sessionId,
      subject: session.subject,
      scopes: [...session.scopes],
      expiresAt,
    });
    return {
      ticket: Redacted.make(ticket),
      expiresAt: DateTime.toUtc(DateTime.makeUnsafe(expiresAt)),
    } satisfies AuthWebSocketTicketResult;
  });

  const redeemVoiceTicket = Effect.fn("ChatDictation.redeemVoiceTicket")(function* (
    ticket: string,
  ) {
    const entry = tickets.get(ticket);
    if (entry === undefined) return Option.none<VoiceTicketSession>();
    tickets.delete(ticket);
    const now = yield* Clock.currentTimeMillis;
    if (entry.expiresAt <= now) return Option.none<VoiceTicketSession>();
    const { expiresAt: _, ...session } = entry;
    return Option.some<VoiceTicketSession>(session);
  });

  return ChatDictation.of({
    qualifies,
    admit,
    charge,
    issueVoiceTicket,
    redeemVoiceTicket,
  });
});

export const layer = Layer.effect(ChatDictation, make);
