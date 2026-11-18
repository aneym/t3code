import type {
  AuthEnvironmentScope,
  ModelSelection,
  ProjectId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import { guestHostImageType, repliesShowImage } from "../guest/guestAttachments.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ChatSessionGrants from "./ChatSessionGrants.ts";
import * as ChatThreadSets from "./ChatThreadSets.ts";
import type { ChatSession } from "./ChatThreadSets.ts";

const ATTACHMENT_CACHE_MS = 15_000;

export interface ChatSessionAccess {
  readonly session: ChatSession;
  readonly inSet: (threadId: ThreadId) => boolean;
  readonly ownsThread: (threadId: ThreadId) => boolean;
  readonly modelEnabled: (selection: ModelSelection) => Effect.Effect<boolean>;
  readonly projectIds: Effect.Effect<ReadonlySet<ProjectId>>;
  readonly ownsUpload: (attachmentId: string) => Effect.Effect<boolean>;
  readonly attachmentVisible: (attachmentId: string) => Effect.Effect<boolean>;
  readonly attachmentUsable: (threadId: ThreadId, attachmentId: string) => Effect.Effect<boolean>;
  readonly messageShowsImage: (threadId: ThreadId, path: string) => Effect.Effect<boolean>;
}

const makeChatSessionAccess = (
  session: ChatSession,
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  grants: ChatSessionGrants.ChatSessionGrants["Service"],
  providers: Effect.Effect<ReadonlyArray<ServerProvider>>,
): ChatSessionAccess => {
  const attachmentCache = new Map<
    ThreadId,
    { readonly at: number; readonly ids: ReadonlySet<string> }
  >();

  const inSet = (threadId: ThreadId) => session.threads.has(threadId);
  const ownsThread = (threadId: ThreadId) => inSet(threadId) && session.ownerThreads.has(threadId);
  const ownsUpload = (attachmentId: string) => grants.ownsUpload(session.setId, attachmentId);

  const modelEnabled = (selection: ModelSelection) =>
    providers.pipe(
      Effect.map((list) =>
        list.some(
          (provider) =>
            provider.instanceId === selection.instanceId &&
            provider.enabled &&
            provider.models.some((model) => model.slug === selection.model),
        ),
      ),
    );

  const projectIds =
    session.threads.size === 0
      ? Effect.succeed<ReadonlySet<ProjectId>>(new Set())
      : projections.getShellSnapshot({ threadIds: [...session.threads] }).pipe(
          Effect.map(
            (snapshot): ReadonlySet<ProjectId> =>
              new Set(
                [...snapshot.threads, ...snapshot.archivedThreads].flatMap((thread) =>
                  session.threads.has(thread.id) ? [thread.projectId] : [],
                ),
              ),
          ),
          Effect.orElseSucceed((): ReadonlySet<ProjectId> => new Set()),
        );

  const threadAttachmentIds = Effect.fnUntraced(function* (threadId: ThreadId) {
    const now = yield* Clock.currentTimeMillis;
    const cached = attachmentCache.get(threadId);
    if (cached !== undefined && now - cached.at < ATTACHMENT_CACHE_MS) return cached.ids;
    const ids = yield* projections
      .getThreadAttachmentIds(threadId)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const entry = { at: now, ids: new Set<string>(ids) };
    attachmentCache.set(threadId, entry);
    return entry.ids as ReadonlySet<string>;
  });

  const inThreadAttachments = (threadId: ThreadId, attachmentId: string) =>
    threadAttachmentIds(threadId).pipe(Effect.map((ids) => ids.has(attachmentId)));

  const attachmentUsable = (threadId: ThreadId, attachmentId: string) =>
    !inSet(threadId) || attachmentId.length === 0
      ? Effect.succeed(false)
      : ownsUpload(attachmentId).pipe(
          Effect.flatMap((own) =>
            own ? Effect.succeed(true) : inThreadAttachments(threadId, attachmentId),
          ),
        );

  const attachmentVisible = (attachmentId: string) =>
    ownsUpload(attachmentId).pipe(
      Effect.flatMap((own) => {
        if (own) return Effect.succeed(true);
        const segment = parseThreadSegmentFromAttachmentId(attachmentId);
        const threads = [...session.threads];
        const matching = threads.filter(
          (threadId) => toSafeThreadAttachmentSegment(threadId) === segment,
        );
        const candidates = matching.length > 0 ? matching : threads;
        return Effect.forEach(candidates, (threadId) =>
          inThreadAttachments(threadId, attachmentId),
        ).pipe(Effect.map((found) => found.some(Boolean)));
      }),
    );

  const messageShowsImage = (threadId: ThreadId, path: string) =>
    guestHostImageType(path) === null
      ? Effect.succeed(false)
      : projections.getThreadRecords(threadId, ["messages"]).pipe(
          Effect.map((records) => repliesShowImage(path, records.messages)),
          Effect.orElseSucceed(() => false),
        );

  return {
    session,
    inSet,
    ownsThread,
    modelEnabled,
    projectIds,
    ownsUpload,
    attachmentVisible,
    attachmentUsable,
    messageShowsImage,
  };
};

export interface ChatSessionContext {
  readonly access: ChatSessionAccess;
  readonly grants: ChatSessionGrants.ChatSessionGrants["Service"];
}

export class ChatSessionResolver extends Context.Service<
  ChatSessionResolver,
  {
    readonly resolve: (session: {
      readonly subject: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<ChatSessionContext | undefined>;
  }
>()("t3/chatSession/ChatSessionAccess/ChatSessionResolver") {}

export const layer = Layer.effect(
  ChatSessionResolver,
  Effect.gen(function* () {
    const sets = yield* ChatThreadSets.ChatThreadSets;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const grants = yield* ChatSessionGrants.ChatSessionGrants;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    return ChatSessionResolver.of({
      resolve: Effect.fn("ChatSessionResolver.resolve")(function* (session) {
        const chat = yield* sets.forSession(session).pipe(Effect.orElseSucceed(() => undefined));
        if (chat === undefined) return undefined;
        return {
          access: makeChatSessionAccess(chat, projections, grants, registry.getProviders),
          grants,
        };
      }),
    });
  }),
);
