import type { AgentPlacementScore } from "@t3tools/contracts";

const DEFAULT_WEIGHT = 50;
const ZERO = "Weight is 0.";

export interface WeightSources {
  readonly callerEntry: number | undefined;
  readonly own: number | undefined;
  readonly label: string;
}

export const callerWeight = (entry: number | undefined) => entry ?? DEFAULT_WEIGHT;

export const linkedWeight = ({ callerEntry, own }: WeightSources) =>
  Math.min(callerWeight(callerEntry), own ?? Number.POSITIVE_INFINITY);

export const explainWeight = (
  score: AgentPlacementScore,
  sources: WeightSources,
): AgentPlacementScore => {
  const caller = callerWeight(sources.callerEntry);
  const own = sources.own;
  if (score.skipped === ZERO)
    return {
      ...score,
      skipped:
        own !== undefined && own < caller
          ? `${sources.label} set its own weight to 0.`
          : "Weight is 0 in this environment's settings.",
    };
  if (own === undefined || own >= caller) return score;
  const said = `${sources.label} set its own weight to ${own}; this environment gives it ${caller}.`;
  return { ...score, note: score.note === undefined ? said : `${said} ${score.note}` };
};
