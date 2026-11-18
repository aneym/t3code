import { SlidersHorizontalIcon } from "lucide-react";

import {
  toggleEmbedControls,
  useEmbedControlsKey,
  useEmbedControlsShown,
} from "../../embed/embedComposer";
import { useEmbedHostConnected } from "../../embed/embedHost";
import { hostChordWords } from "../../embed/embedProtocol";
import { isMacPlatform } from "../../lib/utils";
import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function EmbedControlsToggle() {
  const embedded = useEmbedHostConnected();
  const shown = useEmbedControlsShown();
  const key = useEmbedControlsKey();
  if (!embedded) return null;
  const label = shown ? "Hide model and access" : "Show model and access";
  const keyWords = key === null ? null : hostChordWords(key, isMacPlatform(navigator.platform));
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            data-embed-controls-toggle=""
            className="w-7 px-0"
            aria-pressed={shown}
            aria-label={label}
            onPointerDown={(event) => event.preventDefault()}
            onClick={toggleEmbedControls}
          />
        }
      >
        <ComposerControlIcon icon={SlidersHorizontalIcon} />
      </TooltipTrigger>
      <TooltipPopup side="top">{keyWords ? `${label} (${keyWords})` : label}</TooltipPopup>
    </Tooltip>
  );
}
