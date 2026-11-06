import type { SettingsSearchItem } from "./settingsSearch";

export const browserAgentSettingsSearch = [
  {
    id: "agent-browser-access",
    title: "Agent browser access",
    to: "/settings/browser",
    scope: "project-defaults",
    searchTerms: ["allow disable enable open drive preview tools sessions project override"],
  },
  {
    id: "preview-open-on-user-device",
    title: "Open agent tabs on your desktop",
    to: "/settings/browser",
    scope: "environment-defaults",
    searchTerms: ["preview open remote device desktop local browser panel show user focused"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const browserPanelSettingsSearch = [
  {
    id: "browser-auto-show-floating-preview",
    title: "Auto-show floating preview",
    to: "/settings/browser",
    searchTerms: ["agent opens browser device simulator pop into view hide"],
  },
  {
    id: "remote-device-tabs",
    title: "Show agent tabs from other machines",
    to: "/settings/browser",
    searchTerms: [
      "remote device desktop agent tabs other machine environment show preview consent",
    ],
  },
  {
    id: "remote-device-control",
    title: "Let other machines control agent tabs",
    to: "/settings/browser",
    searchTerms: ["remote device desktop agent control cdp drive click type script cookies"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
