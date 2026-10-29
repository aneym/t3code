import type { SettingsSearchItem } from "./settingsSearch";

export const queueSettingsSearch: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "queue-send-all",
    title: "Send all queued messages",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["queue bulk send all queued steer follow up"],
  },
  {
    id: "batch-queued-messages",
    title: "Send queued messages together",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["queue queued messages batch combine together one turn release drain follow up"],
  },
];
