import { useTheme } from "../../hooks/useTheme";
import { AppCardFrame } from "./AppCardFrame";
import { appCardFrameSource } from "./appCardFrame.logic";
import type { TimelineRow } from "./timelineRowContext";

export function AppCardTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "app-card" }> }) {
  const { resolvedTheme } = useTheme();
  const src = appCardFrameSource(row.card.card, resolvedTheme);
  return <AppCardFrame key={src} src={src} title={row.card.server ?? "Rails app"} />;
}
