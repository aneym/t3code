import { PASSKEY_FALLBACK_CHANNEL } from "./GuestProtocol.ts";

type CreationOptions = CredentialCreationOptions & {
  readonly mediation?: CredentialMediationRequirement;
};
type AskFallback = (
  channel: typeof PASSKEY_FALLBACK_CHANNEL,
  kind: "create" | "get",
) => Promise<unknown>;

const notAllowed = () =>
  new DOMException(
    "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.",
    "NotAllowedError",
  );

export function installPasskeyFallback(ask: AskFallback) {
  if (typeof CredentialsContainer === "undefined") return;
  const container = CredentialsContainer.prototype;
  const nativeCreate = container.create;
  const nativeGet = container.get;
  const guarded = (kind: "create" | "get", native: typeof nativeGet) =>
    async function (this: CredentialsContainer, options?: CreationOptions) {
      if (!options?.publicKey || options.mediation === "conditional") {
        return Reflect.apply(native, this, [options]);
      }
      const choice = await ask(PASSKEY_FALLBACK_CHANNEL, kind).catch(() => "native");
      if (choice !== "native") throw notAllowed();
      return Reflect.apply(native, this, [options]);
    };
  for (const [key, value] of [
    ["create", guarded("create", nativeCreate)],
    ["get", guarded("get", nativeGet)],
  ] as const) {
    Object.defineProperty(container, key, { value, configurable: true, writable: true });
  }
}
