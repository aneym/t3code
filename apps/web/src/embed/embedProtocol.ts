const EMBED_PATH_PREFIX = "/embed/";

const EMBED_THEME_MESSAGE = "t3-embed/theme";
export const EMBED_KEY_MESSAGE = "t3-embed/key";
export const EMBED_OPEN_MESSAGE = "t3-embed/open";
export const EMBED_READY_MESSAGE = "t3-embed/ready";
const EMBED_CLEAR_MESSAGE = "t3-embed/clear";
const EMBED_KEYS_MESSAGE = "t3-embed/keys";
export const EMBED_CLEAR_REQUEST_MESSAGE = "t3-embed/clear-request";
export const EMBED_COMPOSER_FOCUS_MESSAGE = "t3-embed/composer-focus";

export type EmbedScheme = "light" | "dark";

export type EmbedThemeMessage = {
  readonly type: typeof EMBED_THEME_MESSAGE;
  readonly scheme: EmbedScheme;
  readonly vars: Readonly<Record<string, string>>;
};

export type EmbedClearMarker = { readonly at: string; readonly item: string | null };

export type EmbedClearMessage = {
  readonly thread: string;
  readonly marker: EmbedClearMarker | null;
};

export type EmbedOutboundMessage =
  | { readonly type: typeof EMBED_READY_MESSAGE; readonly threadId: string }
  | { readonly type: typeof EMBED_KEY_MESSAGE; readonly key: string }
  | { readonly type: typeof EMBED_OPEN_MESSAGE; readonly url: string }
  | ({
      readonly type: typeof EMBED_CLEAR_REQUEST_MESSAGE;
      readonly thread: string;
    } & EmbedClearMarker)
  | { readonly type: typeof EMBED_COMPOSER_FOCUS_MESSAGE; readonly focused: boolean };

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

function messageRecord(data: unknown, type: string): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  return message.type === type ? message : null;
}

export function readEmbedThemeMessage(data: unknown): EmbedThemeMessage | null {
  const message = messageRecord(data, EMBED_THEME_MESSAGE);
  if (message === null) return null;
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

export function readEmbedClearMessage(data: unknown): EmbedClearMessage | null {
  const message = messageRecord(data, EMBED_CLEAR_MESSAGE);
  if (message === null || typeof message.thread !== "string") return null;
  if (message.at === null || message.at === undefined) {
    return { thread: message.thread, marker: null };
  }
  if (typeof message.at !== "string" || Number.isNaN(Date.parse(message.at))) return null;
  const item = typeof message.item === "string" ? message.item : null;
  return { thread: message.thread, marker: { at: message.at, item } };
}

export function readEmbedKeysMessage(data: unknown): { readonly kClears: boolean } | null {
  const message = messageRecord(data, EMBED_KEYS_MESSAGE);
  return message === null ? null : { kClears: message.k_clears === true };
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
  if (event.shiftKey) {
    if (event.code === "KeyT") return "mod+shift+t";
    return event.code === "KeyK" ? "mod+shift+k" : null;
  }
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
