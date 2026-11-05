const MIN_HIDDEN_CHARS = 8;
const ALWAYS_HIDDEN_RUN = 28;

export function credentialValues(url: string, secret?: string): ReadonlyArray<string> {
  const token = url.split("/").at(-1);
  return [
    url,
    ...(secret === undefined
      ? []
      : [secret, secret.replace(/^whsec_/, ""), secret.replace(/^whsec_/, "").replace(/=+$/, "")]),
    ...(token === undefined ? [] : [token]),
  ].filter((value) => value.length >= MIN_HIDDEN_CHARS);
}

const TOKEN_RUN = /[A-Za-z0-9+/=_%.~-]{16,}/g;

export function redactTokens(text: string): string {
  return text.replace(TOKEN_RUN, (run) =>
    run.length >= ALWAYS_HIDDEN_RUN || /\d/.test(run) ? "<redacted>" : run,
  );
}

export function redact(text: string, hidden: ReadonlyArray<string>): string {
  return [...hidden]
    .toSorted((a, b) => b.length - a.length)
    .reduce((current, value) => current.split(value).join("<redacted>"), text);
}
