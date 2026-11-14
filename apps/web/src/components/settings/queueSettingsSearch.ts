import type { SettingsSearchItem } from "./settingsSearch";

export const queueSettingsSearch: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "show-chat-changed-files",
    title: "Changed files in chat",
    to: "/settings/general",
    searchTerms: ["diff inline hide show card files changed timeline message"],
  },
  {
    id: "retain-automation-placement",
    title: "Keep automation threads together",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["automation sidebar placement webhook scheduled event"],
  },
  {
    id: "batch-queued-messages",
    title: "Send queued messages together",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["queue queued messages batch combine together one turn release drain follow up"],
  },
  {
    id: "queue-send-all",
    title: "Send all queued",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["queue queued messages send all bulk steer start every release"],
  },
  {
    id: "quiet-thread-notes",
    title: "Quiet thread notes",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["note notes back office agent message silent quiet context no turn"],
  },
  {
    id: "child-completion-notes",
    title: "Quiet child completions",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: [
      "delegate delegated child subagent completion result wake note quiet clean gaps awaited",
    ],
  },
  {
    id: "headless-child-threads",
    title: "Headless child threads",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["headless child subagent delegate stream streaming partial thinking performance"],
  },
  {
    id: "mcp-events",
    title: "MCP Events subscriptions",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["mcp events subscribe webhook trigger wake thread rails"],
  },
  {
    id: "mcp-client-approvals",
    title: "Approvals from MCP clients",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["mcp client cli phone rails approve decline permission request remote"],
  },
];
