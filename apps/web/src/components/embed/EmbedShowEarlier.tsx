import { revealEmbedCleared } from "../../embed/embedClear";

export function EmbedShowEarlier({ hidden }: { readonly hidden: number }) {
  if (hidden === 0) return null;
  return (
    <div className="messages-timeline-row-frame shrink-0">
      <div className="chat-content-lane">
        <button
          type="button"
          onClick={revealEmbedCleared}
          className="flex min-h-11 w-full cursor-pointer items-center gap-3 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
          <span className="shrink-0">Show earlier</span>
          <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
        </button>
      </div>
    </div>
  );
}
