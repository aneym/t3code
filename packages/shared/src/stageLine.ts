const STAGE_LINE = /^[*_`\s]*(?:Working|Done|Review|Blocked|Scope|Live) ·/;

export function withoutTrailingStageLine(text: string): string {
  const lines = text.split("\n");
  let at = lines.length - 1;
  while (at >= 0 && !lines[at]?.trim()) at--;
  if (at < 0 || !STAGE_LINE.test(lines[at]?.trim() ?? "")) return text;
  return lines.slice(0, at).join("\n").trimEnd();
}
