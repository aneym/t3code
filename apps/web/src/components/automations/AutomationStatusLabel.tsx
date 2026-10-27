import { CircleAlertIcon, CircleDashedIcon } from "lucide-react";

import { WorkingDuration } from "../sidebar/WorkingDuration";
import type { AutomationStatus } from "./automationStatus";

export function AutomationStatusLabel({ status }: { readonly status: AutomationStatus }) {
  if (status.kind === "working") {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-info-foreground">
        <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
        Working
        <span aria-hidden>
          <WorkingDuration startedAt={status.startedAt} />
        </span>
      </span>
    );
  }
  if (status.kind === "failed") {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-error-foreground">
        <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
        Failed
      </span>
    );
  }
  return <span className="text-secondary-label">Idle</span>;
}
