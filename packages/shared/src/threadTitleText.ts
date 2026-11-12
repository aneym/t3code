const LEADING_MARKDOWN = /^(?:#{1,6}(?:\s+|$)|>\s*|[-*+]\s+|\d{1,3}[.)]\s+|\[[ xX]\]\s+)+/u;
const DECORATION_ONLY = /^(?:[`~]{3,}.*|[-*_=](?:\s*[-*_=]){2,})$/u;

export function plainTitleLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (DECORATION_ONLY.test(trimmed)) continue;
    const plain = trimmed
      .replace(LEADING_MARKDOWN, "")
      .replace(/`+|\*\*/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (plain.length > 0) return plain;
  }
  return "";
}
