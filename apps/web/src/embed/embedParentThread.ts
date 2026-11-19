import { chatSessionActive, chatSessionListsThread } from "@t3tools/client-runtime/chat-session";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { readThreadShell } from "../state/entities";

const MAX_SUBAGENT_HOPS = 8;

export function embedParentThreadId(ref: ScopedThreadRef): string | undefined {
  const session = chatSessionActive();
  if (session && chatSessionListsThread(ref.threadId)) return undefined;
  let top: string | undefined;
  let shell = readThreadShell(ref);
  for (let hop = 0; hop < MAX_SUBAGENT_HOPS && shell !== null; hop++) {
    const { parentThreadId, relationshipToParent } = shell.lineage;
    if (relationshipToParent !== "subagent" || parentThreadId === null) break;
    if (session && chatSessionListsThread(parentThreadId)) return parentThreadId;
    top = parentThreadId;
    shell = readThreadShell(scopeThreadRef(ref.environmentId, parentThreadId));
  }
  return session ? undefined : top;
}
