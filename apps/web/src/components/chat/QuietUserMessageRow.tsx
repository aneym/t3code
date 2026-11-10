import { useAtomValue } from "@effect/atom-react";
import { laneResultOf, type LaneResult } from "@t3tools/client-runtime/lane-result";
import { railsCommentOf, type RailsComment } from "@t3tools/client-runtime/rails-comment";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEmbedHostConnected } from "../../embed/embedHost";
import { embedQuietLine, type EmbedQuietLine } from "../../embed/embedQuietMessages";
import { serverEnvironment } from "../../state/server";
import type { ChatMessage } from "../../types";
import { EmbedQuietMessageRow } from "../embed/EmbedQuietMessageRow";
import { LaneResultRow } from "./LaneResultRow";
import { RailsCommentCard } from "./RailsCommentCard";

export type QuietUserLine =
  | { readonly kind: "lane"; readonly lane: LaneResult }
  | { readonly kind: "comment"; readonly comment: RailsComment }
  | { readonly kind: "embed"; readonly line: EmbedQuietLine };

export function useQuietUserLine(
  message: ChatMessage,
  environmentId: EnvironmentId,
): QuietUserLine | null {
  const embedConnected = useEmbedHostConnected();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const lane = (settings?.laneResultRowsEnabled ?? true) ? laneResultOf(message) : null;
  if (lane !== null) return { kind: "lane", lane };
  const comment = (settings?.railsCommentCardsEnabled ?? true) ? railsCommentOf(message) : null;
  if (comment !== null) return { kind: "comment", comment };
  const line = embedConnected ? embedQuietLine(message) : null;
  return line === null ? null : { kind: "embed", line };
}

export function QuietUserMessageRow({
  message,
  line,
}: {
  readonly message: ChatMessage;
  readonly line: QuietUserLine;
}) {
  return line.kind === "lane" ? (
    <LaneResultRow lane={line.lane} />
  ) : line.kind === "comment" ? (
    <RailsCommentCard comment={line.comment} />
  ) : (
    <EmbedQuietMessageRow message={message} line={line.line} />
  );
}
