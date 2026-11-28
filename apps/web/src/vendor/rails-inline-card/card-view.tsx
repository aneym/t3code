import { memo, useCallback, useMemo, useState } from "react";
import { CARD_LIMITS, type CardAction, type CardNode, type InlineCard, safeCardUrl } from "./inline-card";
import { ChartView, ListView, StatsView, TableView, toneClass } from "./card-data";

export type CardHost = { open(url: string): void; fill?(prompt: string): void };

type Ctx = { card: InlineCard; host: CardHost };

function act(action: CardAction, host: CardHost) {
  if (action.kind === "fill") return host.fill?.(action.prompt);
  const url = safeCardUrl(action.url);
  if (url) host.open(url);
}

function Tabs({ node, ctx }: { node: Extract<CardNode, { type: "Tabs" }>; ctx: Ctx }) {
  const [active, setActive] = useState(node.defaultTab ?? node.tabs[0]?.id);
  const current = node.tabs.find((t) => t.id === active) ?? node.tabs[0];
  if (!current) return null;
  return (
    <div className="rk-tabs">
      <div className="rk-tab-list" role="tablist">
        {node.tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === current.id} className={`rk-tab${t.id === current.id ? " rk-tab-on" : ""}`} onClick={() => setActive(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        <Node id={current.child} ctx={ctx} />
      </div>
    </div>
  );
}

const Kids = ({ ids, ctx }: { ids: string[]; ctx: Ctx }) => ids.map((id) => <Node key={id} id={id} ctx={ctx} />);

const Node = memo(function Node({ id, ctx }: { id: string; ctx: Ctx }) {
  const node = ctx.card.nodes[id];
  if (!node) return null;
  switch (node.type) {
    case "Card":
      return (
        <article className="rk-card">
          <header className="rk-card-head">
            <h3 className="rk-card-title">{node.title}</h3>
            {node.badge && <span className={`rk-badge ${toneClass(node.badge.tone)}`}>{node.badge.label}</span>}
          </header>
          {node.subtitle && <p className="rk-card-sub">{node.subtitle}</p>}
          <div className="rk-stack rk-gap-md">
            <Kids ids={node.children} ctx={ctx} />
          </div>
        </article>
      );
    case "Stack":
      return (
        <div className={`rk-stack${node.direction === "row" ? " rk-row" : ""} ${node.gap === "sm" ? "rk-gap-sm" : "rk-gap-md"}`}>
          <Kids ids={node.children} ctx={ctx} />
        </div>
      );
    case "Grid":
      return (
        <div className="rk-grid" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${node.minColPx ?? 160}px), 1fr))` }}>
          <Kids ids={node.children} ctx={ctx} />
        </div>
      );
    case "Tabs":
      return <Tabs node={node} ctx={ctx} />;
    case "Stats":
      return <StatsView node={node} />;
    case "Chart":
      return <ChartView node={node} />;
    case "Table":
      return <TableView node={node} />;
    case "List":
      return <ListView node={node} />;
    case "Badge":
      return <span className={`rk-badge ${toneClass(node.tone)}`}>{node.label}</span>;
    case "Callout":
      return (
        <div className={`rk-callout ${toneClass(node.tone ?? "info")}`} role="note">
          {node.title && <div className="rk-callout-title">{node.title}</div>}
          <div className="rk-callout-body">{node.body}</div>
        </div>
      );
    case "ActionRow": {
      const items = node.items.filter((it) => it.action.kind === "link" || ctx.host.fill);
      if (!items.length) return null;
      return (
        <div className="rk-actions">
          {items.map((it, i) => (
            <button key={i} type="button" className={`rk-btn rk-btn-${it.variant ?? "secondary"}`} onClick={(e) => e.isTrusted && act(it.action, ctx.host)}>
              {it.label}
            </button>
          ))}
        </div>
      );
    }
  }
});

export function InlineCardView({ card, host }: { card: InlineCard; host: CardHost }) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(0);
  const ctx = useMemo(() => ({ card, host }), [card, host]);
  const watch = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const measure = () => setHidden(Math.max(0, Math.ceil(el.scrollHeight - CARD_LIMITS.height)));
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    measure();
    return () => seen.disconnect();
  }, []);
  const clipped = !open && hidden > 8;
  return (
    <div data-inline-card="" className={`rk-root${open ? " rk-open" : ""}`}>
      <div ref={open ? undefined : watch} className="rk-clip">
        <Node id={card.root} ctx={ctx} />
      </div>
      {clipped && (
        <div className="rk-more">
          <button type="button" className="rk-btn rk-btn-ghost" aria-expanded={false} onClick={() => setOpen(true)}>
            Show full card
          </button>
        </div>
      )}
    </div>
  );
}
