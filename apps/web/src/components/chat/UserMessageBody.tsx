import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import {
  CHAT_USER_MARKDOWN_REMARK_PLUGINS,
  remarkEnableOrderedListNumbers,
} from "@t3tools/shared/markdownPipeline";
import { memo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown, { type ChatMarkdownContextReference } from "../ChatMarkdown";
import { Button } from "../ui/button";
import { findRevealRef } from "./markdownFindContext";
import { MESSAGE_HEADING_LEVEL } from "./TimelineRowParts";
import { useTallEnoughToFold } from "./useTallEnoughToFold";

export const USER_BUBBLE_CLASS_NAME =
  "relative min-w-0 max-w-[80%] rounded-2xl text-message-foreground";

export const BUBBLE_CHIP_CLASS_NAME =
  "[&_[data-slot=context-chip]]:[--context-chip-ink:var(--context-chip-message,var(--context-chip-accent))]";

const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;

const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

export const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  renderContextReference?: (reference: ChatMarkdownContextReference) => ReactNode;
  skills: ReadonlyArray<ServerProviderSkill>;
  markdownCwd: string | undefined;
  threadRef: ScopedThreadRef | undefined;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const revealForFind = () => setExpanded(true);
  const revealRef = findRevealRef(revealForFind);
  const hasVisibleBody = props.text.trim().length > 0;
  const { ref: contentRef, tallEnough: canCollapse } = useTallEnoughToFold(
    props.collapsible !== false && hasVisibleBody,
  );
  const isCollapsed = canCollapse && !expanded;
  const showCollapseControl = canCollapse;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          ref={revealRef}
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-thread-find-text="true"
          data-thread-find-fold={isCollapsed ? "" : undefined}
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <div ref={contentRef}>
            <UserMessageBody
              text={props.text}
              renderContextReference={props.renderContextReference}
              skills={props.skills}
              markdownCwd={props.markdownCwd}
              threadRef={props.threadRef}
            />
          </div>
        </div>
      ) : null}
      {showCollapseControl ? (
        <div className="mt-1.5 flex items-center justify-end gap-2" data-user-message-footer="true">
          {showCollapseControl ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const USER_MESSAGE_REMARK_PLUGINS = [
  ...CHAT_USER_MARKDOWN_REMARK_PLUGINS,
  remarkEnableOrderedListNumbers,
];

export const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  renderContextReference?: ((reference: ChatMarkdownContextReference) => ReactNode) | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
  markdownCwd: string | undefined;
  threadRef: ScopedThreadRef | undefined;
}) {
  if (props.text.length === 0) {
    return null;
  }
  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      threadRef={props.threadRef}
      skills={props.skills}
      className="text-message-foreground user-message-markdown"
      lineBreaks
      parseRawHtml={false}
      extraRemarkPlugins={USER_MESSAGE_REMARK_PLUGINS}
      renderContextReference={props.renderContextReference}
      headingLevelOffset={MESSAGE_HEADING_LEVEL}
    />
  );
});
