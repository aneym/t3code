const APP_LINK_PROTOCOL = /^t3code(?:-[a-z]+)?:$/;
const TICKET_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;

export interface RailsConnectLink {
  readonly ticket: string;
  readonly origin: string;
}

export const readRailsConnectLink = (value: string): RailsConnectLink | null => {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (!APP_LINK_PROTOCOL.test(url.protocol) || url.host !== "rails") return null;
  if (url.pathname !== "/connect" || url.hash !== "") return null;
  const ticket = url.searchParams.get("ticket");
  if (ticket === null || !TICKET_PATTERN.test(ticket)) return null;
  const rails = url.searchParams.get("rails");
  if (rails === null || !URL.canParse(rails)) return null;
  const origin = new URL(rails).origin;
  return origin === "null" ? null : { ticket, origin };
};
