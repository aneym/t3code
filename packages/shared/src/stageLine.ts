const STAGE_LINE = /^[*_`\s]*(?:Working|Done|Review|Blocked|Scope|Live|Settled|Snoozed) ·/;
const LIST_ITEM = /^\s*(?:[-*•]|\d+\.)\s/;

export function withoutTrailingStageLine(text: string): string {
  const lines = text.split("\n");
  let at = lines.length - 1;
  while (at >= 0 && !STAGE_LINE.test(lines[at] ?? "")) at--;
  if (at < 0 || !lines.slice(at + 1).every((line) => !line.trim() || LIST_ITEM.test(line)))
    return text;
  return lines.slice(0, at).join("\n").trimEnd() || text;
}
