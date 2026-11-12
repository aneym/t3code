import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { withoutRailsDeskContext } from "./userMessage.ts";

export type RailsCommentKind = "escalate" | "task" | "note";

export interface RailsComment {
  readonly kind: RailsCommentKind;
  readonly author: string;
  readonly docTitle: string | null;
  readonly label: string | null;
  readonly quote: string | null;
  readonly text: string;
  readonly pinUrl: string | null;
}

export const RAILS_COMMENT_KIND_LABELS = {
  escalate: "Needs the lane",
  task: "Filed as task",
  note: "Note",
} satisfies Record<RailsCommentKind, string>;

const NOTICE = /^\[rails:comment\] (.+)$/;
const BODY = /^```json\r?\n([\s\S]+?)\r?\n```\s*$/;
const WEB_LINK = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String));

const decodeBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      notice: Schema.String,
      kind: Schema.Literals(["escalate", "task", "note"]),
      author: Schema.Struct({ name: Schema.String }),
      doc: Schema.NullOr(Schema.Struct({ title: Schema.String })),
      pin: Schema.String,
      label: OptionalText,
      quote: OptionalText,
      text: Schema.String,
    }),
  ),
);

const present = (value: string | null | undefined) =>
  value === undefined || value === null || value.trim() === "" ? null : value;

export function railsCommentOf(message: {
  readonly role: string;
  readonly text: string;
}): RailsComment | null {
  if (message.role !== "user") return null;
  const text = withoutRailsDeskContext(message.text);
  const lineEnd = text.indexOf("\n");
  if (lineEnd < 0) return null;
  const firstLine = text.slice(0, lineEnd).replace(/\r$/, "");
  if (!NOTICE.test(firstLine)) return null;
  const body = BODY.exec(text.slice(lineEnd + 1));
  if (body === null) return null;
  const decoded = decodeBody(body[1]);
  if (Option.isNone(decoded) || decoded.value.notice !== firstLine) return null;
  const note = decoded.value;
  return {
    kind: note.kind,
    author: present(note.author.name) ?? "Someone",
    docTitle: present(note.doc?.title),
    label: present(note.label),
    quote: present(note.quote),
    text: note.text,
    pinUrl: WEB_LINK.test(note.pin) ? note.pin : null,
  };
}
