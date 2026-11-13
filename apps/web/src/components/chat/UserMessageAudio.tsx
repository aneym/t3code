import type { ChatFileAttachment, EnvironmentId } from "@t3tools/contracts";
import type { RailsVoiceMemo } from "@t3tools/client-runtime/rails-voice";

import { cn } from "~/lib/utils";
import { InlineAudioPreview } from "../files/InlineAudioPreview";
import { VoiceMemoMessage } from "./VoiceMemoMessage";

const audioResource = (file: ChatFileAttachment) => ({
  _tag: "attachment" as const,
  attachmentId: file.id,
  fileName: file.name,
  mimeType: file.mimeType,
  disposition: "inline" as const,
});

export function UserMessageAudio(props: {
  readonly files: ReadonlyArray<ChatFileAttachment>;
  readonly audioOnly: boolean;
  readonly voice: RailsVoiceMemo | undefined;
  readonly time: string;
  readonly environmentId: EnvironmentId;
  readonly onOpen: (file: ChatFileAttachment) => void;
}) {
  if (props.files.length === 0) return null;
  const [memo, ...rest] = props.voice ? props.files : [];
  const chips = memo ? rest : props.files;
  return (
    <div className={cn("flex max-w-full flex-col gap-1", !props.audioOnly && "mb-2")}>
      {memo && props.voice ? (
        <VoiceMemoMessage
          voice={props.voice}
          name={memo.name}
          environmentId={props.environmentId}
          resource={audioResource(memo)}
          time={props.time}
          onOpen={() => props.onOpen(memo)}
        />
      ) : null}
      {chips.map((file) => (
        <InlineAudioPreview
          key={file.id}
          name={file.name}
          variant={props.audioOnly ? "bubble" : "chip"}
          environmentId={props.environmentId}
          resource={audioResource(file)}
          onOpen={() => props.onOpen(file)}
        />
      ))}
    </div>
  );
}
