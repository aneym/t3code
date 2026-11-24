import { AudioLinesIcon } from "lucide-react";

import { useEmbedHostConnected } from "../../embed/embedHost";
import { pressEmbedHostVoice, useEmbedHostVoice } from "../../embed/embedHostVoice";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function EmbedHostVoiceButton() {
  const embedded = useEmbedHostConnected();
  const voice = useEmbedHostVoice();
  if (!embedded || !voice.shown) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            data-embed-host-voice=""
            aria-label={voice.label}
            aria-pressed={voice.active}
            onPointerDown={(event) => event.preventDefault()}
            onClick={pressEmbedHostVoice}
            className="shrink-0"
          />
        }
      >
        <AudioLinesIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">{voice.label}</TooltipPopup>
    </Tooltip>
  );
}
