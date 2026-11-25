import type { SettingsSearchItem } from "./settingsSearch";

export const forkChatDisplaySearch: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "hide-trailing-stage-line",
    title: "Hide stage lines",
    to: "/settings/chat",
    searchTerms: ["agent status line done working review blocked scope live last line reply"],
  },
  {
    id: "keep-opening-reply-visible",
    title: "Keep replies visible",
    to: "/settings/chat",
    searchTerms: [
      "first message opening line last line every line inline link reply answer worked for fold collapse hidden tool call superseded steer",
    ],
  },
];
