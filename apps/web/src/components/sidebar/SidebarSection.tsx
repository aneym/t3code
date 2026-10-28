import * as Schema from "effect/Schema";
import type { ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";

export function SidebarSection(props: {
  readonly label: string;
  readonly storageKey: string;
  readonly defaultExpanded?: boolean;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useLocalStorage(
    props.storageKey,
    props.defaultExpanded ?? true,
    Schema.Boolean,
  );
  return (
    <section aria-label={props.label} className="flex flex-col">
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        accessory={
          props.count === undefined ? null : (
            <span className="font-normal tabular-nums">{props.count}</span>
          )
        }
      >
        {props.label}
      </CollapsibleSectionHeader>
      {expanded ? props.children : null}
    </section>
  );
}
