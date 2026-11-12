import {
  RAILS_COMMENT_KIND_LABELS,
  type RailsComment,
} from "@t3tools/client-runtime/rails-comment";
import { ExternalLinkIcon, MessageSquareTextIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { MessageAuthorHeading } from "./TimelineRowParts";

export function RailsCommentCard({ comment }: { readonly comment: RailsComment }) {
  const where = comment.docTitle ?? "a page";
  return (
    <div className="flex min-w-0 flex-col items-start" data-rails-comment={comment.kind}>
      <MessageAuthorHeading>{`${comment.author} commented on ${where}`}</MessageAuthorHeading>
      <div
        className="flex w-full max-w-[80%] min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card px-3 py-2.5 text-card-foreground"
        data-thread-find-text="true"
      >
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <MessageSquareTextIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-foreground">{comment.author}</span>
            {" on "}
            <span className="font-medium text-foreground">{where}</span>
          </span>
          <Badge variant="secondary" size="sm">
            {RAILS_COMMENT_KIND_LABELS[comment.kind]}
          </Badge>
        </div>
        {comment.quote !== null || comment.label !== null ? (
          <blockquote className="min-w-0 border-border border-s ps-2.5 text-xs text-muted-foreground">
            {comment.label !== null ? (
              <span className="block font-medium">{comment.label}</span>
            ) : null}
            {comment.quote !== null ? (
              <span className="line-clamp-3 whitespace-pre-wrap break-words">{comment.quote}</span>
            ) : null}
          </blockquote>
        ) : null}
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm">{comment.text}</p>
        {comment.pinUrl !== null ? (
          <a
            href={comment.pinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 self-start rounded-sm text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Open comment
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        ) : null}
      </div>
    </div>
  );
}
