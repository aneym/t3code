import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { useEmbedHostConnected } from "../../embed/embedHost";
import { setEmbedLivePeek, useEmbedLivePeek } from "../../embed/embedLivePeek";

export function EmbedLivePeek({ at }: { readonly at: string | null | undefined }) {
  const embedded = useEmbedHostConnected();
  const open = useEmbedLivePeek() === at;
  if (!embedded || !at) return null;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? "Hide steps" : "Show steps"}
      data-scroll-anchor-ignore
      data-embed-live-peek
      onClick={() => setEmbedLivePeek(open ? null : at)}
      className="-my-1 flex size-6 shrink-0 cursor-pointer items-center justify-center self-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
    </button>
  );
}
