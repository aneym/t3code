import * as Context from "effect/Context";

const CLAIM_MS = 120_000;

export class ClaimedSlot extends Context.Service<ClaimedSlot, { readonly token: number }>()(
  "t3/orchestration-v2/DelegatedChildClaims/ClaimedSlot",
) {}

export type ClaimResult = { readonly wouldHold?: string; readonly token?: number };

export const SPILL_REFUSED = "Spill refused: ";

export const makeClaims = () => {
  const claims = new Map<
    number,
    { readonly groups: ReadonlyArray<string>; readonly at: number; readonly until: number }
  >();
  let next = 0;
  const add = (groups: ReadonlyArray<string>, now: number) => {
    next += 1;
    claims.set(next, { groups, at: now, until: now + CLAIM_MS });
    return next;
  };
  const take = (token: number) => claims.delete(token);
  const count = (
    running: ReadonlyMap<string, number>,
    lastStart: ReadonlyMap<string, number>,
    now: number,
    own?: number,
  ) => {
    const counted = new Map(running);
    const started = new Map(lastStart);
    for (const [token, claim] of claims) {
      if (claim.until <= now) {
        claims.delete(token);
        continue;
      }
      if (token === own) continue;
      for (const group of claim.groups) {
        counted.set(group, (counted.get(group) ?? 0) + 1);
        started.set(group, Math.max(started.get(group) ?? 0, claim.at));
      }
    }
    return { counted, started };
  };
  return { add, take, count };
};
