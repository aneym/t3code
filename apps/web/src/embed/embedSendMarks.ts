import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import { MCP_APP_CARD_HOST_TOKEN } from "@t3tools/shared/mcpAppCard";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { postToEmbedHost } from "./embedHost";
import {
  EMBED_SEND_MARK_MESSAGE,
  type EmbedSendFailure,
  type EmbedSendMark,
  type EmbedSendMilestone,
  inEmbedPage,
} from "./embedProtocol";

interface OpenSend {
  readonly thread: string;
  readonly until: number;
  readonly posted: Set<EmbedSendMilestone>;
  runId: string | null;
  answerId: string | null;
}

export type EmbedSendRun = { readonly runId: string; readonly status: string };

const RAN = new Set(["running", "waiting", "completed"]);

const OPEN_MS = 600_000;
const USER_ROW = '[data-timeline-row-kind="message"][data-message-role="user"]';
const SCROLL = { capture: true, passive: true } as const;
const MILESTONES = 5;
const sends = new Map<string, OpenSend>();
let observer: MutationObserver | null = null;
let frame: number | null = null;
const railsShell =
  typeof navigator !== "undefined" && navigator.userAgent.includes(MCP_APP_CARD_HOST_TOKEN);

export function sendMarksToWindow(): boolean {
  return railsShell && !inEmbedPage();
}

function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

function inputTime(): number {
  const event = globalThis.event;
  return event instanceof UIEvent || event instanceof SubmitEvent
    ? performance.timeOrigin + event.timeStamp
    : epochNow();
}

export function postEmbedSendMark(thread: string, mark: EmbedSendMark, at = epochNow()): boolean {
  const message = { type: EMBED_SEND_MARK_MESSAGE, thread, at, ...mark } as const;
  if (!sendMarksToWindow()) return postToEmbedHost(message);
  window.postMessage(message, window.location.origin);
  return true;
}

function close(messageId: string): void {
  sends.delete(messageId);
  if (sends.size > 0) return;
  observer?.disconnect();
  observer = null;
  document.removeEventListener("scroll", schedule, SCROLL);
  window.removeEventListener("resize", schedule);
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
}

function reach(messageId: string, milestone: EmbedSendMilestone, at?: number): void {
  const send = sends.get(messageId);
  if (send === undefined || send.posted.has(milestone)) return;
  send.posted.add(milestone);
  postEmbedSendMark(send.thread, { mark: milestone, messageId }, at);
  if (send.posted.size === MILESTONES) close(messageId);
}

function painted(selector: string): boolean {
  const row = document.querySelector(selector);
  return row !== null && (row.textContent ?? "").trim() !== "";
}

function onScreen(row: Element): boolean {
  if (!row.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  let { top, bottom, left, right } = row.getBoundingClientRect();
  for (let box = row.parentElement; box !== null; box = box.parentElement) {
    const style = getComputedStyle(box);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const clip = box.getBoundingClientRect();
    top = Math.max(top, clip.top);
    bottom = Math.min(bottom, clip.bottom);
    left = Math.max(left, clip.left);
    right = Math.min(right, clip.right);
  }
  top = Math.max(top, 0);
  left = Math.max(left, 0);
  bottom = Math.min(bottom, window.innerHeight);
  right = Math.min(right, window.innerWidth);
  return bottom > top && right > left;
}

function userRowShown(messageId: string): boolean {
  const row = document.querySelector(`${USER_ROW}[data-message-id="${CSS.escape(messageId)}"]`);
  return row !== null && (row.textContent ?? "").trim() !== "" && onScreen(row);
}

function paint(): void {
  frame = null;
  const at = epochNow();
  for (const [messageId, send] of sends) {
    if (at > send.until) {
      close(messageId);
      continue;
    }
    if (!send.posted.has("drawn") && userRowShown(messageId)) reach(messageId, "drawn", at);
    const answer = send.answerId === null ? null : CSS.escape(send.answerId);
    if (
      answer !== null &&
      painted(`[data-message-id="${answer}"][data-message-role="assistant"]`)
    ) {
      reach(messageId, "word", at);
    }
  }
}

function schedule(): void {
  if (frame === null && sends.size > 0) frame = requestAnimationFrame(paint);
}

export function embedSendEnter<T extends string>(thread: string, messageId: T): T {
  if (sends.has(messageId) || !(railsShell || inEmbedPage())) return messageId;
  const at = inputTime();
  if (!postEmbedSendMark(thread, { mark: "enter", messageId }, at)) return messageId;
  sends.set(messageId, {
    thread,
    until: at + OPEN_MS,
    posted: new Set(["enter"]),
    runId: null,
    answerId: null,
  });
  if (observer === null) {
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener("scroll", schedule, SCROLL);
    window.addEventListener("resize", schedule);
  }
  schedule();
  return messageId;
}

export function failEmbedSend(messageId: string, reason: EmbedSendFailure): void {
  const send = sends.get(messageId);
  if (send === undefined || send.posted.has("accepted")) return;
  close(messageId);
  postEmbedSendMark(send.thread, { mark: "failed", messageId, reason });
}

function failureReason(failure: AtomCommandResult<unknown, unknown>): EmbedSendFailure {
  if (isAtomCommandInterrupted(failure)) return "interrupted";
  if (failure._tag !== "Failure") return "rejected";
  const error = squashAtomCommandFailure(failure);
  const transient =
    (error as { readonly _tag?: unknown } | null)?._tag === "ConnectionTransientError" ||
    (error instanceof Error && isTransportConnectionErrorMessage(error.message));
  return transient ? "connection" : "rejected";
}

export function embedSendFailed<F extends AtomCommandResult<unknown, unknown>>(
  messageId: string,
  failure: F | null,
): failure is F {
  if (failure !== null && sends.has(messageId)) failEmbedSend(messageId, failureReason(failure));
  return failure !== null;
}

export function openEmbedSendId(thread: string): string | null {
  let newest: string | null = null;
  for (const [messageId, send] of sends) {
    if (send.thread === thread && !send.posted.has("accepted")) newest = messageId;
  }
  return newest;
}

export function followEmbedSends(
  thread: string,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  latestRun: EmbedSendRun | null,
): void {
  if (sends.size === 0) return;
  for (const { item } of items) {
    if (item.type === "user_message") {
      const send = sends.get(item.messageId);
      if (send === undefined || send.thread !== thread) continue;
      send.runId = item.runId ?? send.runId;
      reach(item.messageId, "accepted");
    } else if (item.type === "assistant_message" && item.runId !== null && item.text.trim()) {
      for (const send of sends.values()) {
        if (send.runId === item.runId && send.answerId === null) send.answerId = item.messageId;
      }
    }
  }
  for (const [messageId, send] of sends) {
    if (send.thread !== thread || send.runId === null) continue;
    if (latestRun?.runId === send.runId && RAN.has(latestRun.status)) {
      reach(messageId, "turnStarted");
    }
  }
  schedule();
}
