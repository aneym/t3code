import { queuedRunRows, type QueuedRowThumbnail } from "./queuedRunRows";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveThreadQueueWorkflowState,
  canSendAllQueued,
  describeSendAllQueued,
} from "@t3tools/client-runtime/state/thread-workflows";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import type {
  ChatAttachment as ContractChatAttachment,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { QueuedMessage } from "./QueuedMessage";
import { serverEnvironment } from "../../state/server";
import { useAtomValue } from "@effect/atom-react";
import { ArrowUpIcon, ChevronDownIcon, Clock3Icon, PencilIcon, XIcon } from "lucide-react";
import { useId, useImperativeHandle, useRef, useState, type Ref } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { TimestampFormat } from "@t3tools/contracts/settings";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

// A longer queue shows its first messages and a button that shows the rest.
const QUEUE_VISIBLE_ROWS = 3;

export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  sendAll: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

type ThreadQueueProjection = Parameters<typeof deriveThreadQueueWorkflowState>[0];

function queuedImageResources(projection: ThreadQueueProjection | undefined) {
  if (!projection) return [];
  return deriveThreadQueueWorkflowState(projection).queuedRuns.flatMap(({ attachments }) =>
    attachments.flatMap((attachment) =>
      attachment.type === "image"
        ? [{ _tag: "attachment" as const, attachmentId: attachment.id }]
        : [],
    ),
  );
}

export function QueuedRunsControl({
  ref,
  ...props
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly steerShortcutLabel?: string | null;
  readonly editShortcutLabel?: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">
  >;
  readonly editingRunId: RunId | null;
  /** Set while something else holds the composer, such as an open question. */
  readonly editBlockedReason: string | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly onCancelEdit: () => void;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const sendAll = useAtomCommand(threadEnvironment.sendAllQueuedRuns);
  const queueSendAll =
    useAtomValue(serverEnvironment.configValueAtom(props.environmentId))?.settings.queueSendAll ===
    true;
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const [showAll, setShowAll] = useState(false);
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const steerInFlightRef = useRef(false);
  // Run-only acknowledgements can resurrect pending rows after cancellation or startup.
  const acknowledgedMessageIds = new Set((projection?.messages ?? []).map((message) => message.id));
  const queuedImageAttachmentResources = queuedImageResources(projection);
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const workflow = projection ? deriveThreadQueueWorkflowState(projection) : null;
  const canSendAll = canSendAllQueued(workflow, props.editingRunId !== null);
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;
  const canSend = workflow?.canSendNow === true || workflow?.canPromoteToSteer === true;
  const queuedImageUrlById = new Map(
    queuedImageAttachmentUrls.flatMap((url, index) => {
      const resource = queuedImageAttachmentResources[index];
      return url && resource ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) => message.inputIntent === "queued_turn" && !acknowledgedMessageIds.has(message.id),
  );
  const items = queuedRunRows(queued, optimisticQueued, queuedImageUrlById);

  const sendQueuedMessage = async (queuedRunId: RunId) => {
    if (
      !canSend ||
      steerInFlightRef.current ||
      queued.find((entry) => entry.run.id === queuedRunId)?.isBackgroundResult
    )
      return;
    steerInFlightRef.current = true;
    setBusyRunId(queuedRunId);
    if (workflow?.canSendNow) {
      await resume({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId: queuedRunId },
      });
    } else if (activeRun !== null) {
      await promote({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
      });
    }
    steerInFlightRef.current = false;
    setBusyRunId(null);
  };

  const sendAllMessages = async () => {
    if (!queueSendAll || !canSendAll || steerInFlightRef.current || busyRunId !== null) return;
    steerInFlightRef.current = true;
    setBusyRunId(queued[0]!.run.id);
    try {
      await sendAll({ environmentId: props.environmentId, input: { threadId: props.threadId } });
    } finally {
      steerInFlightRef.current = false;
      setBusyRunId(null);
    }
  };

  useImperativeHandle(ref, () => ({
    sendAll(repeat) {
      if (!queueSendAll || !canSendAll) return false;
      if (!repeat) void sendAllMessages();
      return true;
    },
    steerNext(repeat) {
      const next = queued[0];
      if (!next || !canSend || next.isBackgroundResult) return false;
      if (!repeat && busyRunId === null) void sendQueuedMessage(next.run.id);
      return true;
    },
    // Leave the key to caret navigation while editing.
    editLatest(repeat) {
      const latest = queued.at(-1);
      if (
        !latest ||
        latest.isBackgroundResult ||
        latest.context?.guest !== undefined ||
        props.editingRunId !== null ||
        props.editBlockedReason !== null ||
        busyRunId !== null
      ) {
        return false;
      }
      if (!repeat) {
        setShowAll(true);
        props.onEditQueuedRun({
          runId: latest.run.id,
          messageId: latest.run.userMessageId,
          text: latest.text,
          attachments: latest.attachments,
        });
      }
      return true;
    },
  }));

  if (items.length === 0) return null;

  const remove = async (runId: RunId) => {
    setBusyRunId(runId);
    await cancel({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId },
    });
    setBusyRunId(null);
  };

  const collapsible = items.length > QUEUE_VISIBLE_ROWS;
  const visibleItems = collapsible && !showAll ? items.slice(0, QUEUE_VISIBLE_ROWS - 1) : items;

  return (
    <section
      aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
      data-thread-queue="true"
      // Anchors the sr-only live region; unanchored, it escapes the timeline scroller and makes the chat column scroll.
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {items.length} queued
      </span>
      {queueSendAll && canSendAll && workflow ? (
        <div className="flex justify-end">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busyRunId !== null}
                  onClick={() => void sendAllMessages()}
                >
                  Send all
                </Button>
              }
            />
            <TooltipPopup>{describeSendAllQueued(workflow)}</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      <ol className="flex flex-col items-end gap-3" id={queueListId}>
        {visibleItems.map((item, position) => {
          const previewText = isAttachmentOnlyBootstrapPrompt(item.text)
            ? ""
            : assistantCitationsToPlainText(
                replaceComposerContextReferences(item.text, (reference) =>
                  reference.kind === "image" && item.thumbnails.length > 0 ? "" : reference.label,
                ),
              ).trim();
          const isEditing = item.runId !== null && item.runId === props.editingRunId;
          return (
            <li
              key={item.key}
              aria-label={`Queued message ${position + 1} of ${items.length}, not sent`}
              aria-posinset={position + 1}
              aria-setsize={items.length}
              aria-current={isEditing ? "true" : undefined}
              className="group/queued flex w-full flex-col items-end gap-1 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
            >
              <QueuedMessage
                environmentId={props.environmentId}
                message={item.message}
                previewText={previewText}
                thumbnails={item.thumbnails}
                isEditing={isEditing}
                timestampFormat={props.timestampFormat}
                onOpenThread={props.onOpenThread}
              >
                {canSend && !isEditing && !item.isBackgroundResult ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger render={<span className="flex shrink-0" />}>
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={
                            item.runId === null || busyRunId !== null || item.isBackgroundResult
                          }
                          onClick={() => {
                            if (item.runId !== null) {
                              void sendQueuedMessage(item.runId);
                            }
                          }}
                        >
                          <ArrowUpIcon />
                          Send now
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {`${workflow?.canSendNow ? "Start a turn with this message" : workflow?.promoteSkipsCompaction ? "Skip compaction and send this message" : "Send into the current turn"}${item.serverIndex === 0 && props.steerShortcutLabel ? ` (${props.steerShortcutLabel})` : ""}`}
                      </TooltipPopup>
                    </Tooltip>
                  </>
                ) : null}
                {item.pending ? (
                  <span className="flex items-center gap-1 px-1">
                    <Clock3Icon aria-hidden className="size-3" />
                    Saving
                  </span>
                ) : null}
                {isEditing ? (
                  <>
                    <span className="px-1 text-foreground">Editing in the composer</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="Cancel editing queued message"
                      onClick={props.onCancelEdit}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Tooltip>
                      {/* The span keeps the tooltip, and its reason, on a disabled button. */}
                      <TooltipTrigger render={<span className="flex shrink-0" />}>
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label="Edit queued message"
                          disabled={
                            item.runId === null ||
                            !item.editable ||
                            busyRunId !== null ||
                            props.editBlockedReason !== null
                          }
                          onClick={() => {
                            if (item.runId !== null && item.messageId !== null) {
                              props.onEditQueuedRun({
                                runId: item.runId,
                                messageId: item.messageId,
                                text: item.text,
                                attachments: item.attachments,
                              });
                            }
                          }}
                        >
                          <PencilIcon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {props.editBlockedReason ??
                          `Edit in the composer${item.serverIndex === queued.length - 1 && props.editShortcutLabel ? ` (${props.editShortcutLabel})` : ""}`}
                      </TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label="Remove queued message"
                            disabled={
                              item.runId === null || busyRunId !== null || item.isBackgroundResult
                            }
                            onClick={() => {
                              if (item.runId !== null) void remove(item.runId);
                            }}
                          />
                        }
                      >
                        <XIcon />
                      </TooltipTrigger>
                      <TooltipPopup>Remove from queue</TooltipPopup>
                    </Tooltip>
                  </>
                )}
              </QueuedMessage>
            </li>
          );
        })}
      </ol>
      {collapsible ? (
        <div className="self-end pe-1 text-xs pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5">
          <InlineButton
            tone="muted"
            aria-expanded={showAll}
            aria-controls={queueListId}
            // Keep the composer focused; keyboard activation still works.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer" : `Show all ${items.length} queued`}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                showAll && "rotate-180",
              )}
            />
          </InlineButton>
        </div>
      ) : null}
    </section>
  );
}
