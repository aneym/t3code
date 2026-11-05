const MIN_HIDDEN_CHARS = 8;

export function credentialValues(url: string, secret?: string): ReadonlyArray<string> {
  const token = url.split("/").at(-1);
  return [
    url,
    ...(secret === undefined ? [] : [secret, secret.replace(/^whsec_/, "")]),
    ...(token === undefined ? [] : [token]),
  ].filter((value) => value.length >= MIN_HIDDEN_CHARS);
}

export function redact(text: string, hidden: ReadonlyArray<string>): string {
  return [...hidden]
    .toSorted((a, b) => b.length - a.length)
    .reduce((current, value) => current.split(value).join("<redacted>"), text);
}
