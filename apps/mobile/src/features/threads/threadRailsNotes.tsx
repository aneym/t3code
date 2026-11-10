import { useAtomValue } from "@effect/atom-react";
import { laneResultOf } from "@t3tools/client-runtime/lane-result";
import { railsCommentOf } from "@t3tools/client-runtime/rails-comment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import type { ColorValue } from "react-native";

import { serverEnvironment } from "../../state/server";
import { ThreadLaneResultRow } from "./ThreadLaneResultRow";
import { ThreadRailsCommentCard } from "./ThreadRailsCommentCard";

export interface RailsNoteRows {
  readonly laneResults: boolean;
  readonly commentCards: boolean;
}

export function useRailsNoteRows(environmentId: EnvironmentId): RailsNoteRows {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const laneResults = settings?.laneResultRowsEnabled ?? true;
  const commentCards = settings?.railsCommentCardsEnabled ?? true;
  return useMemo(() => ({ laneResults, commentCards }), [laneResults, commentCards]);
}

export function railsNoteRow(
  message: { readonly role: string; readonly text: string },
  rows: RailsNoteRows,
  tint: ColorValue,
) {
  const lane = rows.laneResults ? laneResultOf(message) : null;
  if (lane !== null) return <ThreadLaneResultRow lane={lane} tint={tint} />;
  const comment = rows.commentCards ? railsCommentOf(message) : null;
  return comment === null ? null : <ThreadRailsCommentCard comment={comment} />;
}
