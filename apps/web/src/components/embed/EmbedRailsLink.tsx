import type { EmbedRailsLink } from "../../embed/embedLinks";

function fallbackTitle(href: string): string {
  const path = new URL(href).pathname;
  if (path.startsWith("/x/")) return "Doc";
  if (/^\/a\/[^/]+\/lanes\/[^/]+/.test(path)) return "Lane";
  return path.startsWith("/a/") ? "Agent" : "Rails";
}

const isUrlText = (text: string) => /^https?:\/\//i.test(text.trim());

export function EmbedRailsLinkChip({
  href,
  link,
  label,
}: {
  href: string;
  link: EmbedRailsLink;
  label: string | null;
}) {
  const title =
    label && label.trim() && !isUrlText(label)
      ? label.trim()
      : (link.ref?.title ?? fallbackTitle(href));
  const icon = link.ref?.icon ?? link.mark;
  return (
    <span
      data-rails-link={link.ref?.kind ?? "page"}
      className="inline-flex max-w-full items-baseline gap-1.25 rounded-md border border-border bg-muted py-px ps-1 pe-1.75 align-baseline font-medium text-foreground leading-snug hover:bg-accent"
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          draggable={false}
          className="size-[15px] flex-none self-center select-none rounded-sm"
        />
      ) : null}
      <span className="truncate">{title}</span>
    </span>
  );
}
