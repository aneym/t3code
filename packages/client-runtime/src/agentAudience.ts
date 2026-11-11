export type AudienceMessage = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly runId: string | null;
  readonly senderThreadId?: string | undefined;
  readonly quietNote?: true | undefined;
  readonly scheduledTaskId?: string | undefined;
  readonly mcpEvent?: object | undefined;
};

export type AudienceItem =
  | { readonly kind: "message"; readonly id: string; readonly message: AudienceMessage }
  | { readonly kind: "request"; readonly id: string }
  | {
      readonly kind: "notice";
      readonly id: string;
      readonly runId: string | null;
      readonly fromSystem?: true | undefined;
    }
  | {
      readonly kind: "ask";
      readonly id: string;
      readonly runId: string | null;
      readonly to: string | null;
    }
  | { readonly kind: "run"; readonly id: string; readonly runId: string | null };

export type AgentAudience = {
  readonly items: ReadonlySet<string>;
  readonly runs: ReadonlySet<string>;
};

const THREAD_SEND = /:thread-send:[^:]+:([^:]+):[0-9a-f]{32}$/;
const FOR_PERSON = /^(chat-note-|chat-yes-|rails-comment-|rails-one-comment-)/;
const FROM_AGENTS = /^(rails-lane-|lane-start-)/;
const SCHEDULED_PROMPT = /^scheduled-task-message:/;
const MCP_EVENT = /^message:mcp-events:/;
const RAILS_SENDS = /^fork-note-/;
const AGENT_SENDS = /^(t3fr-|office-digest-)/;
const RAILS_ASK_CARD = "ui://rails/question";
const RAILS_OWNER = "owner";
const HANDOFF = /^Handed over from [^\n]{1,80}?\. The person asked /;

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function threadSendRequestId(messageId: string): string | null {
  const sent = THREAD_SEND.exec(messageId);
  return sent ? decoded(sent[1]!) : null;
}

export function systemSender(
  message: Pick<AudienceMessage, "id" | "role" | "senderThreadId" | "scheduledTaskId" | "mcpEvent">,
): string | null {
  if (message.role !== "user" || message.senderThreadId !== undefined) return null;
  if (message.scheduledTaskId !== undefined || SCHEDULED_PROMPT.test(message.id)) {
    return "a scheduled task";
  }
  if (message.mcpEvent !== undefined || MCP_EVENT.test(message.id)) return "T3";
  const sent = threadSendRequestId(message.id);
  if (sent === null) return null;
  if (RAILS_SENDS.test(sent)) return "Rails";
  return AGENT_SENDS.test(sent) ? "another agent" : null;
}

function messageFromAgents(message: AudienceMessage, threadId: string): boolean {
  if (message.role !== "user") return false;
  const sent = threadSendRequestId(message.id);
  if (sent !== null && FOR_PERSON.test(sent)) return false;
  if (sent !== null && FROM_AGENTS.test(sent)) return true;
  return (
    (message.senderThreadId !== undefined && message.senderThreadId !== threadId) ||
    message.quietNote === true ||
    HANDOFF.test(message.text) ||
    systemSender(message) !== null
  );
}

export function railsAskTo(
  app: { readonly tool: string; readonly resourceUri: string },
  input: unknown,
): string | null {
  if (app.tool !== "ask" || app.resourceUri !== RAILS_ASK_CARD) return null;
  if (typeof input !== "object" || input === null || !("to" in input)) return null;
  return typeof input.to === "string" ? input.to : null;
}

export function agentAudience(
  items: ReadonlyArray<AudienceItem>,
  threadId: string,
  replies = false,
): AgentAudience {
  const firstOfRun = new Map<string, boolean>();
  const fromAgents = new Set<string>();
  for (const item of items) {
    const sent =
      item.kind === "notice"
        ? { agents: item.fromSystem !== true, runId: item.runId }
        : item.kind === "message" && item.message.role === "user"
          ? { agents: messageFromAgents(item.message, threadId), runId: item.message.runId }
          : null;
    if (sent === null) continue;
    if (sent.agents) fromAgents.add(item.id);
    if (sent.runId !== null && !firstOfRun.has(sent.runId)) firstOfRun.set(sent.runId, sent.agents);
  }
  const runs = new Set(
    replies ? [] : [...firstOfRun].filter(([, agents]) => agents).map(([runId]) => runId),
  );
  const hidden = new Set<string>();
  for (const item of items) {
    if (item.kind === "request" || (item.kind === "ask" && item.to === RAILS_OWNER)) continue;
    if (item.kind === "ask" && item.to !== null) {
      hidden.add(item.id);
      continue;
    }
    if (item.kind === "notice" || (item.kind === "message" && item.message.role === "user")) {
      if (fromAgents.has(item.id)) hidden.add(item.id);
      continue;
    }
    const runId = item.kind === "message" ? item.message.runId : item.runId;
    if (runId !== null && runs.has(runId)) hidden.add(item.id);
  }
  return { items: hidden, runs };
}
