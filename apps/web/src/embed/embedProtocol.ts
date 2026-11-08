const EMBED_PATH_PREFIX = "/embed/";

const EMBED_THEME_MESSAGE = "t3-embed/theme";
export const EMBED_KEY_MESSAGE = "t3-embed/key";
export const EMBED_OPEN_MESSAGE = "t3-embed/open";
export const EMBED_READY_MESSAGE = "t3-embed/ready";

export type EmbedScheme = "light" | "dark";

export type EmbedThemeMessage = {
  readonly type: typeof EMBED_THEME_MESSAGE;
  readonly scheme: EmbedScheme;
  readonly vars: Readonly<Record<string, string>>;
};

export type EmbedOutboundMessage =
  | { readonly type: typeof EMBED_READY_MESSAGE; readonly threadId: string }
  | { readonly type: typeof EMBED_KEY_MESSAGE; readonly key: string }
  | { readonly type: typeof EMBED_OPEN_MESSAGE; readonly url: string };

const MAX_THEME_VARS = 256;
const MAX_VALUE_LENGTH = 200;
const VAR_NAME = /^--[a-z0-9-]{1,64}$/;
const UNSAFE_VALUE = /[;{}<>\\]|url\(|expression\(|@import/i;

export function isEmbedPath(pathname: string): boolean {
  return pathname.startsWith(EMBED_PATH_PREFIX);
}

export function readEmbedScheme(value: unknown): EmbedScheme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function readEmbedThemeMessage(data: unknown): EmbedThemeMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type !== EMBED_THEME_MESSAGE) return null;
  const scheme = readEmbedScheme(message.scheme);
  if (scheme === null) return null;
  const vars: Record<string, string> = {};
  const raw = message.vars;
  if (typeof raw === "object" && raw !== null) {
    for (const [name, value] of Object.entries(raw).slice(0, MAX_THEME_VARS)) {
      if (!VAR_NAME.test(name) || typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_VALUE_LENGTH) continue;
      if (UNSAFE_VALUE.test(trimmed)) continue;
      vars[name] = trimmed;
    }
  }
  return { type: EMBED_THEME_MESSAGE, scheme, vars };
}

const LETTER_CHORDS: Readonly<Record<string, string>> = {
  KeyK: "mod+k",
  KeyW: "mod+w",
  KeyT: "mod+t",
  Comma: "mod+,",
};
const DIGIT_CODE = /^Digit([1-9])$/;

export function reservedEmbedChord(event: KeyboardEvent, mac: boolean): string | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return null;
  if (event.shiftKey) return event.code === "KeyT" ? "mod+shift+t" : null;
  const letter = LETTER_CHORDS[event.code];
  if (letter !== undefined) return letter;
  const digit = DIGIT_CODE.exec(event.code);
  return digit ? `mod+${digit[1]}` : null;
}

export function normalizeEmbedOrigins(entries: ReadonlyArray<string>): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of entries) {
    if (!URL.canParse(entry)) continue;
    const origin = new URL(entry).origin;
    if (origin !== "null") origins.add(origin);
  }
  return origins;
}
