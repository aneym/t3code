const CLICK_CONSENT_TOOLS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["rails", new Set(["answer", "question_card", "connections_card_source"])],
]);

export const clickConsentAllowed = (server: string, tool: string) =>
  CLICK_CONSENT_TOOLS.get(server)?.has(tool) === true;
