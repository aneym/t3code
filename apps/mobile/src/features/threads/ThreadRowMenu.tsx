import { useState, type ComponentProps } from "react";
import type { MenuAction } from "@react-native-menu/menu";
import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { Menu } from "../../components/ui/Menu";

export function ThreadRowMenu({
  machine,
  agent,
  status,
  startedAt,
  ...props
}: ComponentProps<typeof Menu> & {
  readonly machine: string | null;
  readonly agent: string | null;
  readonly status: string;
  readonly startedAt: string | null;
}) {
  const [openedAt, setOpenedAt] = useState(Date.now);
  const startedAtMs = Date.parse(startedAt ?? "");
  const duration = Number.isFinite(startedAtMs)
    ? ` ${formatWorkingDurationLabel(Math.max(0, openedAt - startedAtMs))}`
    : "";
  const details: MenuAction[] = [
    ...(machine
      ? [{ id: "detail:machine", title: `Machine: ${machine}`, attributes: { disabled: true } }]
      : []),
    ...(agent
      ? [{ id: "detail:agent", title: `Agent: ${agent}`, attributes: { disabled: true } }]
      : []),
    { id: "detail:status", title: `${status}${duration}`, attributes: { disabled: true } },
  ];

  return (
    <Menu
      {...props}
      actions={[
        { id: "thread-details", title: "Thread details", subactions: details },
        ...props.actions,
      ]}
      onMenuInteractionStart={() => {
        setOpenedAt(Date.now());
        props.onMenuInteractionStart?.();
      }}
    />
  );
}
