import { ThreadOrganizeRefusalReason } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isRefusalReason = Schema.is(ThreadOrganizeRefusalReason);
const TAGGED = /^\[([a-z_]+)\] /;

export const tagRejection = (reason: ThreadOrganizeRefusalReason | undefined, message: string) =>
  reason === undefined ? message : `[${reason}] ${message}`;

export const readRejection = (error: string | null | undefined) => {
  const text = error ?? "Previously rejected.";
  const match = TAGGED.exec(text);
  const reason = match?.[1];
  return match !== null && isRefusalReason(reason)
    ? { detail: text.slice(match[0].length), reason }
    : { detail: text };
};
