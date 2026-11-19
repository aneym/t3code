import { chatSessionActive, chatSessionListsThread } from "@t3tools/client-runtime/chat-session";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ServerConfig } from "@t3tools/contracts";

import { readThreadShell } from "../state/entities";
import { embedSessionListsThread } from "./embedKeptViewGate";

const MAX_SUBAGENT_HOPS = 8;

function subagentAncestors(ref: ScopedThreadRef): ReadonlyArray<string> {
  const ancestors: string[] = [];
  let shell = readThreadShell(ref);
  for (let hop = 0; hop < MAX_SUBAGENT_HOPS && shell !== null; hop++) {
    const { parentThreadId, relationshipToParent } = shell.lineage;
    if (relationshipToParent !== "subagent" || parentThreadId === null) break;
    ancestors.push(parentThreadId);
    shell = readThreadShell(scopeThreadRef(ref.environmentId, parentThreadId));
  }
  return ancestors;
}

function embedListedSubagentAncestor(
  ref: ScopedThreadRef,
  listed: (threadId: string) => boolean,
): string | undefined {
  return subagentAncestors(ref).find(listed);
}

export function embedParentThreadId(ref: ScopedThreadRef): string | undefined {
  if (!chatSessionActive()) return subagentAncestors(ref).at(-1);
  if (chatSessionListsThread(ref.threadId)) return undefined;
  return embedListedSubagentAncestor(ref, chatSessionListsThread);
}

export function embedSessionAdmitsThread(
  ref: ScopedThreadRef,
  liveConfig: Pick<ServerConfig, "chatSession"> | null,
): boolean {
  const listed = (threadId: string) =>
    embedSessionListsThread(threadId, liveConfig, chatSessionListsThread(threadId));
  return listed(ref.threadId) || embedListedSubagentAncestor(ref, listed) !== undefined;
}
