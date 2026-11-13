const RAILS_VOICE_MARK =
  /^((?:\[[^\]\n]*\]\(t3-context:\/\/[^)\s]+\)\s*)*)<rails-voice request="[A-Za-z0-9_-]{1,100}" audio="[a-f0-9]{1,64}" seconds="(\d{1,4}(?:\.\d{1,3})?)" file="[A-Za-z0-9_-]{1,64}">[^<]*<\/rails-voice>\s*/;

export type RailsVoiceMemo = { readonly seconds: number; readonly transcript: string };

export function railsVoiceMemo(
  text: string,
): { readonly memo: RailsVoiceMemo; readonly text: string } | null {
  const mark = RAILS_VOICE_MARK.exec(text);
  if (!mark) return null;
  const rest = text.slice(mark[0].length);
  return {
    memo: { seconds: Number(mark[2]), transcript: rest.trim() },
    text: `${mark[1] ?? ""}${rest}`,
  };
}
