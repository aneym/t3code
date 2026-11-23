import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ComposerUploadRetry(props: {
  readonly name: string;
  readonly reason: string;
  readonly disabled: boolean;
  readonly onRetry: () => void;
  readonly variant: "overlay" | "ghost";
  readonly className?: string;
  readonly label?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={props.variant}
            size={props.label ? "micro" : "icon-xs"}
            className={props.className}
            onClick={props.onRetry}
            disabled={props.disabled}
            aria-label={`Retry upload for ${props.name}`}
          />
        }
      >
        <RefreshIcon />
        {props.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}
