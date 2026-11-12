// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

const SIGNATURE_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = "whsec_";

export function newWebhookSecret(): string {
  return `${SECRET_PREFIX}${NodeCrypto.randomBytes(32).toString("base64")}`;
}

export function newUrlToken(): string {
  return NodeCrypto.randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): string {
  return NodeCrypto.createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(tokenHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && NodeCrypto.timingSafeEqual(actual, expected);
}

function signWebhook(input: {
  readonly secret: string;
  readonly id: string;
  readonly timestamp: string;
  readonly body: Uint8Array;
}): string {
  const key = Buffer.from(input.secret.slice(SECRET_PREFIX.length), "base64");
  return NodeCrypto.createHmac("sha256", key)
    .update(`${input.id}.${input.timestamp}.`)
    .update(input.body)
    .digest("base64");
}

export type SignatureCheck = "valid" | "missing_headers" | "stale" | "invalid";

export function verifyWebhook(input: {
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly referenceSeconds: number;
}): SignatureCheck {
  const id = input.headers["webhook-id"];
  const timestamp = input.headers["webhook-timestamp"];
  const signatures = input.headers["webhook-signature"];
  if (!id || !timestamp || !signatures) return "missing_headers";
  if (!/^\d{1,12}$/.test(timestamp)) return "invalid";
  if (Math.abs(input.referenceSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    return "stale";
  }
  const expected = Buffer.from(signWebhook({ ...input, id, timestamp }), "base64");
  for (const entry of signatures.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || value === undefined) continue;
    const candidate = Buffer.from(value, "base64");
    if (candidate.length === expected.length && NodeCrypto.timingSafeEqual(candidate, expected)) {
      return "valid";
    }
  }
  return "invalid";
}
