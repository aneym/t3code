export type EmbedFont = {
  readonly family: string;
  readonly src: string;
  readonly weight: string;
  readonly range: string | null;
};

const MAX_FONTS = 24;
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 .'-]{0,59}$/;
const WEIGHT = /^[1-9]00( [1-9]00)?$|^1000$|^[1-9]00 1000$/;
const RANGE = /^[U+0-9A-Fa-f?,\- ]{1,600}$/;

const loaded = new Set<string>();

function readFont(value: unknown): EmbedFont | null {
  if (typeof value !== "object" || value === null) return null;
  const font = value as Record<string, unknown>;
  const { family, src, weight, range } = font;
  if (typeof family !== "string" || !FAMILY.test(family)) return null;
  if (typeof weight !== "string" || !WEIGHT.test(weight)) return null;
  if (range !== undefined && range !== null && (typeof range !== "string" || !RANGE.test(range)))
    return null;
  if (typeof src !== "string" || !URL.canParse(src)) return null;
  const url = new URL(src);
  if (url.protocol !== "https:" || !url.pathname.endsWith(".woff2")) return null;
  return { family, src: url.href, weight, range: typeof range === "string" ? range : null };
}

export function readEmbedFonts(data: unknown): ReadonlyArray<EmbedFont> {
  if (typeof data !== "object" || data === null) return [];
  const fonts = (data as Record<string, unknown>).fonts;
  if (!Array.isArray(fonts)) return [];
  return fonts
    .slice(0, MAX_FONTS)
    .map(readFont)
    .filter((font): font is EmbedFont => font !== null);
}

export function loadEmbedFonts(fonts: ReadonlyArray<EmbedFont>): void {
  if (typeof FontFace === "undefined") return;
  for (const font of fonts) {
    const key = `${font.family}|${font.weight}|${font.src}`;
    if (loaded.has(key)) continue;
    loaded.add(key);
    const face = new FontFace(font.family, `url("${font.src}") format("woff2")`, {
      weight: font.weight,
      display: "swap",
      ...(font.range === null ? {} : { unicodeRange: font.range }),
    });
    document.fonts.add(face);
    void face.load().catch(() => loaded.delete(key));
  }
}
