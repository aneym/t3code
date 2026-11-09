import type { SettingsSearchItem } from "./settingsSearch";

export const queueSettingsSearch: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "settle-idle-children",
    title: "Settle idle child threads",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["settle parent child subagent delegate idle cleanup worktree"],
  },
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
  {
    id: "quiet-thread-notes",
    title: "Quiet thread notes",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["note notes back office agent message silent quiet context no turn"],
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
    id: "host-link",
    title: "Host app link",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["host app link push turns messages steps thread ends lane rails"],
  },
  {
    id: "mcp-app-remember-tool-grants",
    title: "Remember MCP app approvals",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["mcp app widget tool always allow approval prompt confirm"],
  },
  {
    id: "mcp-app-tool-grants",
    title: "Always allowed MCP app tools",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["mcp app widget tool always allow revoke approval grant"],
  },
  {
    id: "delegated-child-model",
    title: "Delegated child model",
    to: "/settings/chat",
    scope: "environment-defaults",
    searchTerms: ["delegate child subagent task default model inherit opus fable"],
  },
];
