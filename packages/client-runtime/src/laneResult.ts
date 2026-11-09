export type LaneResultState = "finished" | "dropped" | "failed";

export interface LaneResult {
  readonly laneId: string;
  readonly title: string;
  readonly state: LaneResultState;
  readonly detail: string;
}

export const LANE_RESULT_STATE_LABELS = {
  finished: "finished",
  dropped: "dropped",
  failed: "couldn't start",
} satisfies Record<LaneResultState, string>;

const NOTE = /^<rails-desk lane="([^"]+)">[\s\S]*?<\/rails-desk>\s*/;
const LINE =
  /^Rails: the lane "([^"]*)" (finished|was dropped|couldn't start its thread)([\s\S]*)$/;
const ASK =
  / Tell the person in one line of at most 30 words, "[\s\S]*", and leave the rest in the lane\.$/;
const RETRY = / Call lane_start for it again\.$/;
const WHY = /^ \(([\s\S]*)\)\.$/;
const STATES: Record<string, LaneResultState> = {
  finished: "finished",
  "was dropped": "dropped",
  "couldn't start its thread": "failed",
};

function detailOf(rest: string): string {
  if (rest.startsWith(": ")) return rest.slice(2).trim();
  return WHY.exec(rest)?.[1]?.trim() ?? "";
}

export function laneResultOf(message: {
  readonly role: string;
  readonly text: string;
}): LaneResult | null {
  if (message.role !== "user") return null;
  const note = NOTE.exec(message.text);
  if (note === null) return null;
  const visible = message.text.slice(note[0].length).trim().replace(ASK, "").replace(RETRY, "");
  const line = LINE.exec(visible);
  const state = line ? STATES[line[2]!] : undefined;
  if (!line || state === undefined) return null;
  return { laneId: note[1]!, title: line[1]!, state, detail: detailOf(line[3]!) };
}
