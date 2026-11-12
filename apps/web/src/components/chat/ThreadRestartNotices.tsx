import type { ComponentProps } from "react";
import { PauseIcon } from "lucide-react";
import { HandoffRow } from "./V2LifecycleRow";
import { TimelineSystemDivider } from "./TimelineSystemDivider";

export function ThreadRestartNotices(
  props: Omit<ComponentProps<typeof HandoffRow>, "endpoints"> & {
    endpoints: ComponentProps<typeof HandoffRow>["endpoints"] | null;
    label: string | null;
  },
) {
  return (
    <div className="chat-content-lane">
      {props.label === null ? null : <TimelineSystemDivider label={props.label} icon={PauseIcon} />}
      {props.endpoints === null ? null : (
        <HandoffRow
          environmentId={props.environmentId}
          endpoints={props.endpoints}
          providers={props.providers}
          pending
        />
      )}
    </div>
  );
}
