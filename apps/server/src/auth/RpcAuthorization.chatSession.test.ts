import {
  AuthOrchestrationReadScope,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetThreadProjectionError,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import type { ChatSessionAccess } from "../chatSession/ChatSessionAccess.ts";
import { climbToSet } from "../chatSession/ChatSessionDescendants.ts";
import { admitChatRpc } from "../chatSession/chatSessionRpc.ts";
import { makeChatShellFilter } from "../chatSession/chatSessionViews.ts";
import { RPC_REQUIRED_SCOPES } from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

const O = ORCHESTRATION_V2_WS_METHODS;
const W = WS_METHODS;
const id = ThreadId.make;
const set = id("thread:set");
const child = id("thread:child");
const grandchild = id("thread:grandchild");
const fork = id("thread:fork");
const stray = id("thread:stray");
const other = id("thread:other");

const lineage = (
  parentThreadId: ThreadId | null,
  relationshipToParent: OrchestrationV2AppThreadLineage["relationshipToParent"] = "subagent",
): OrchestrationV2AppThreadLineage => ({
  parentThreadId,
  relationshipToParent: parentThreadId === null ? null : relationshipToParent,
  rootThreadId: set,
});

const LINEAGE = new Map<ThreadId, OrchestrationV2AppThreadLineage>([
  [set, lineage(null)],
  [child, lineage(set)],
  [grandchild, lineage(child)],
  [fork, lineage(set, "fork")],
  [stray, lineage(other)],
  [other, lineage(null)],
]);

const makeAccess = (): ChatSessionAccess => {
  const threads = new Set([set]);
  const inSet = (threadId: ThreadId) => threads.has(threadId);
  const hops = new Map<ThreadId, number>();
  const hopsOf = (threadId: ThreadId) => (inSet(threadId) ? 0 : hops.get(threadId));
  return {
    session: { setId: "set", threads, ownerThreads: new Set([set]), ownerPolicy: true },
    inSet,
    ownsThread: inSet,
    admits: (threadId) =>
      hopsOf(threadId) !== undefined
        ? Effect.succeed(true)
        : climbToSet(threadId, hopsOf, (next) => Effect.succeed(LINEAGE.get(next) ?? null)).pipe(
            Effect.map((found) => {
              for (const [step, depth] of found) hops.set(step, depth);
              return found.length > 0;
            }),
          ),
    modelEnabled: () => Effect.succeed(true),
    projectIds: Effect.succeed(new Set()),
    ownsUpload: () => Effect.succeed(false),
    attachmentVisible: () => Effect.succeed(false),
    attachmentUsable: (threadId) => Effect.succeed(inSet(threadId)),
    messageShowsImage: () => Effect.succeed(true),
  };
};

const command = (type: string, extra: object = {}) => ({
  method: O.dispatchCommand,
  payload: (threadId: ThreadId) => ({ type, commandId: "c", threadId, requestId: "r", ...extra }),
});
const byThread = (method: string, extra: object = {}) => ({
  method,
  payload: (threadId: ThreadId) => ({ threadId, ...extra }),
});
const asset = (tag: string) => ({
  method: W.assetsCreateUrl,
  payload: (threadId: ThreadId) => ({ resource: { _tag: tag, threadId, path: "/a.png" } }),
});

const READABLE = [set, child, grandchild];
const SET_ONLY = [set];

const ROWS: ReadonlyArray<
  readonly [
    string,
    { readonly method: string; readonly payload: (threadId: ThreadId) => object },
    ReadonlyArray<ThreadId>,
  ]
> = [
  ["subscribeThread", byThread(O.subscribeThread), READABLE],
  ["getThreadProjection", byThread(O.getThreadProjection), READABLE],
  ["getTurnItem", byThread(O.getTurnItem), READABLE],
  ["getThreadHistoryPage", byThread(O.getThreadHistoryPage), READABLE],
  ["subscribeCommandOutput", byThread(O.subscribeCommandOutput), READABLE],
  ["getNativeChildWork", byThread(O.getNativeChildWork), READABLE],
  ["searchThread", byThread(O.searchThread), READABLE],
  ["searchThreadStream", byThread(O.searchThreadStream), READABLE],
  ["getThreadFamily", byThread(O.getThreadFamily), READABLE],
  ["tool-output-image asset", asset("tool-output-image"), READABLE],
  ["media-file asset", asset("media-file"), READABLE],
  ["runtime-request.respond", command("runtime-request.respond"), READABLE],
  [
    "runtime-request.respond with attachments",
    command("runtime-request.respond", { attachmentsByQuestionId: { q: [{ id: "a" }] } }),
    SET_ONLY,
  ],
  ["thread.user-input.dismiss", command("thread.user-input.dismiss"), READABLE],
  ["thread.visit", command("thread.visit"), READABLE],
  ["secret save", byThread(W.secretsAnswerRequest, { answer: { type: "save" } }), READABLE],
  ["secret decline", byThread(W.secretsAnswerRequest, { answer: { type: "decline" } }), READABLE],
  [
    "secret reference",
    byThread(W.secretsAnswerRequest, { answer: { type: "reference" } }),
    SET_ONLY,
  ],
  [
    "message.dispatch",
    command("message.dispatch", { attachments: [], dispatchMode: { type: "start" } }),
    SET_ONLY,
  ],
  ["run.interrupt", command("run.interrupt"), SET_ONLY],
  ["queue.resume", command("queue.resume"), SET_ONLY],
  ["thread.stop", command("thread.stop"), SET_ONLY],
  ["subagent.stop", command("subagent.stop"), SET_ONLY],
  ["queued-run.cancel", command("queued-run.cancel"), SET_ONLY],
  ["thread.mark-unread", command("thread.mark-unread"), SET_ONLY],
  ["thread.interaction-mode.set", command("thread.interaction-mode.set"), SET_ONLY],
  ["subscribePromptSuggestion", byThread(O.subscribePromptSuggestion), SET_ONLY],
  ["assetsPersistChatAttachments", byThread(W.assetsPersistChatAttachments), SET_ONLY],
];

describe("chat session admission of subagent descendants", () => {
  it.effect.each(ROWS)("%s", ([, row, allowed]) =>
    Effect.gen(function* () {
      const access = makeAccess();
      const admitted: Array<ThreadId> = [];
      for (const threadId of [set, child, grandchild, fork, stray, other]) {
        if (yield* admitChatRpc(row.method, row.payload(threadId), access)) admitted.push(threadId);
      }
      expect(admitted).toEqual(allowed);
    }),
  );

  const shell = (threadId: ThreadId) =>
    ({
      id: threadId,
      projectId: "project",
      lineage: LINEAGE.get(threadId),
    }) as unknown as OrchestrationV2ThreadShell;
  const updated = (threadId: ThreadId) =>
    ({ kind: "thread.updated", sequence: 1, location: "active", thread: shell(threadId) }) as const;
  const kept = (filter: ReturnType<typeof makeChatShellFilter>, threadIds: ThreadId[]) =>
    threadIds.filter((threadId) => filter.apply(updated(threadId)) !== undefined);

  it("keeps a snapshot's subagent closure in any order and drops forks", () => {
    const filter = makeChatShellFilter(new Set([set]), new Set());
    const result = filter.apply({
      kind: "snapshot",
      snapshot: {
        schemaVersion: 2,
        snapshotSequence: 1,
        threads: [grandchild, fork, stray, child, set, other].map(shell),
        archivedThreads: [],
        projects: [],
      },
    } as never);
    expect(
      result?.kind === "snapshot" ? result.snapshot.threads.map((thread) => thread.id) : [],
    ).toEqual([grandchild, child, set]);
  });

  it("keeps a child that arrives after its parent and a resumed grandchild", () => {
    expect(
      kept(makeChatShellFilter(new Set([set]), new Set()), [child, grandchild, fork, stray]),
    ).toEqual([child, grandchild]);
    const seeded = makeChatShellFilter(
      new Set([set]),
      new Set(),
      [...LINEAGE].map(([threadId, entry]) => ({ id: threadId, lineage: entry })),
    );
    expect(kept(seeded, [grandchild, fork, stray, other])).toEqual([grandchild]);
  });

  it.effect("refuses an unrelated thread's history at the RPC boundary and serves a child", () =>
    Effect.gen(function* () {
      const method = O.getThreadHistoryPage;
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
        ),
      );
      const handled: Array<ThreadId> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, ({ threadId }) =>
              Effect.sync(() => handled.push(threadId)).pipe(
                Effect.andThen(
                  Effect.fail(
                    new OrchestrationV2GetThreadProjectionError({ threadId, message: "x" }),
                  ),
                ),
              ),
            ),
            RpcAuthorization.layer([AuthOrchestrationReadScope], undefined, makeAccess()),
          ),
        ),
      );
      const page = (threadId: ThreadId) =>
        client[method]({ threadId, cursor: "c" }).pipe(Effect.flip);
      expect(yield* page(other)).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(yield* page(fork)).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      expect(yield* page(child)).toMatchObject({
        _tag: "OrchestrationV2GetThreadProjectionError",
      });
      expect(handled).toEqual([child]);
    }),
  );
});
