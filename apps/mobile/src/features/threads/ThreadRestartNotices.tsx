import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { restartPauseLabel } from "@t3tools/client-runtime/restart-pause";
import { Atom } from "effect/reactivity";
import type { ComponentProps } from "react";
import { environmentThreadDetails } from "../../state/threads";
import { ThreadContextDivider } from "./thread-context-divider";
import { ThreadHandoffDivider } from "./thread-handoff-row";

const emptyThread = Atom.make(null);

export function ThreadRestartNotices(
  props: Omit<ComponentProps<typeof ThreadHandoffDivider>, "label" | "endpoints"> & {
    detailRef: ScopedThreadRef | null;
    endpoints: ComponentProps<typeof ThreadHandoffDivider>["endpoints"] | null | undefined;
  },
) {
  const label = useAtomValue(
    props.detailRef === null ? emptyThread : environmentThreadDetails.threadAtom(props.detailRef),
    (thread) =>
      typeof thread === "string" || thread === null
        ? null
        : restartPauseLabel(thread?.projection.runs ?? []),
  );
  return (
    <>
      {label === null ? null : (
        <ThreadContextDivider label={label} icon="pause" iconColor={props.iconColor} />
      )}
      {props.endpoints == null ? null : (
        <ThreadHandoffDivider
          environmentId={props.environmentId}
          endpoints={props.endpoints}
          iconColor={props.iconColor}
          surfaceColor={props.surfaceColor}
          label="Context handoff pending"
        />
      )}
    </>
  );
}
