const PRESS_TTL_MS = 60_000;

export interface PersonPress {
  readonly at: number;
  readonly text: string;
}

interface TypedDraft {
  readonly typed: boolean;
  readonly text: string;
  readonly supplied: boolean;
}

const typedDrafts = new WeakMap<object, TypedDraft>();

export function noteTypedChange(owner: object, previous: string, next: string): void {
  const record = typedDrafts.get(owner);
  const continues = record !== undefined && record.typed && record.text === previous;
  const typed = record?.supplied !== true && (previous === "" || continues);
  typedDrafts.set(owner, { typed, text: next, supplied: false });
}

export function markSupplied(owner: object): void {
  typedDrafts.set(owner, {
    typed: false,
    text: typedDrafts.get(owner)?.text ?? "",
    supplied: true,
  });
}

export function pressFrom(
  event: { readonly isTrusted: boolean } | null | undefined,
  owner: object,
  text: string,
): PersonPress | undefined {
  if (event?.isTrusted !== true || text.trim() === "") return undefined;
  const record = typedDrafts.get(owner);
  if (record === undefined || !record.typed || record.text !== text) return undefined;
  return { at: Date.now(), text };
}

export function typedAtFor(press: PersonPress | undefined, text: string): string | null {
  if (press === undefined || press.text !== text || Date.now() - press.at > PRESS_TTL_MS) {
    return null;
  }
  return new Date(press.at).toISOString();
}
