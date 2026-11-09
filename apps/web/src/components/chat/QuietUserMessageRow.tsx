import { useAtomValue } from "@effect/atom-react";
import { laneResultOf, type LaneResult } from "@t3tools/client-runtime/lane-result";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEmbedHostConnected } from "../../embed/embedHost";
import { embedQuietLine, type EmbedQuietLine } from "../../embed/embedQuietMessages";
import { serverEnvironment } from "../../state/server";
import type { ChatMessage } from "../../types";
import { EmbedQuietMessageRow } from "../embed/EmbedQuietMessageRow";
import { LaneResultRow } from "./LaneResultRow";

export type QuietUserLine =
  | { readonly kind: "lane"; readonly lane: LaneResult }
  | { readonly kind: "embed"; readonly line: EmbedQuietLine };

export function useQuietUserLine(
  message: ChatMessage,
  environmentId: EnvironmentId,
): QuietUserLine | null {
  const embedConnected = useEmbedHostConnected();
  const laneRows =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.laneResultRowsEnabled ?? true;
  const lane = laneRows ? laneResultOf(message) : null;
  if (lane !== null) return { kind: "lane", lane };
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
  ) : (
    <EmbedQuietMessageRow message={message} line={line.line} />
  );
}
