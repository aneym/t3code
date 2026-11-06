// @effect-diagnostics globalTimers:off - This isolated Electron preload does not run inside an Effect runtime.
const FIELD_HINT = /one.?time|verif|\b(?:otp|totp|2fa|mfa|pin|code|passcode)\b/u;
const NOT_A_CODE = /postal|zip|promo|coupon|country|area|discount|gift|referral/u;
const TEXT_TYPES = new Set(["", "text", "tel", "number", "password"]);

const isOneTimeCodeField = (element: Element | null): element is HTMLInputElement => {
  if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) return false;
  if (!TEXT_TYPES.has(element.type)) return false;
  if (element.autocomplete.split(/\s+/u).includes("one-time-code")) return true;
  const hints = [
    element.name,
    element.id,
    element.autocomplete,
    element.placeholder,
    element.getAttribute("aria-label") ?? "",
  ]
    .join(" ")
    .replaceAll(/([a-z])([A-Z])/gu, "$1 $2")
    .replaceAll(/[_-]/gu, " ")
    .toLowerCase();
  return FIELD_HINT.test(hints) && !NOT_A_CODE.test(hints);
};

const fill = (field: HTMLInputElement, code: string) => {
  field.select();
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", code);
  const paste = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  if (field.dispatchEvent(paste)) document.execCommand("insertText", false, code);
};

export function installOneTimeCodeWatch(
  report: (focused: boolean) => void,
  onFill: (fill: (code: string) => void) => void,
) {
  let watched: HTMLInputElement | null = null;
  onFill((code) => {
    if (watched !== null && watched === document.activeElement) fill(watched, code);
  });
  const update = () => {
    const active = document.activeElement;
    const next = isOneTimeCodeField(active) ? active : null;
    if (next === watched) return;
    watched = next;
    report(next !== null);
  };
  document.addEventListener("focusin", update, true);
  document.addEventListener("focusout", () => setTimeout(update, 0), true);
  window.addEventListener("pagehide", () => {
    if (watched === null) return;
    watched = null;
    report(false);
  });
}
