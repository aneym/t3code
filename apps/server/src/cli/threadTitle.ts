const TITLE_MAX_CHARS = 80;

export const titleFromMessage = (message: string) => {
  const firstLine = message.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.length > TITLE_MAX_CHARS
    ? `${firstLine.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
    : firstLine;
};
