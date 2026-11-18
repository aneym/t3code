export const RESTRICTED_IMPORT_PATHS = [
  {
    name: "react-native",
    importNames: ["FlatList"],
    message:
      "Use LegendList from @legendapp/list/react-native, with renderScrollComponent={NativeScrollView} in a screen. Pass whatever renderItem reads through extraData: rows only re-render when their item or extraData changes.",
  },
  {
    name: "@t3tools/client-runtime",
    message:
      "Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.",
  },
  {
    name: "@pierre/diffs/react",
    importNames: ["CodeView"],
    message: "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
  },
  {
    name: "react-native-screens",
    importNames: ["ScrollViewMarker"],
    message:
      "Use NativeScrollViewMarker or NativeScrollView (src/native/NativeScrollViewMarker.tsx): they carry the header's scroll-edge blur under the Duo's vertical bar.",
  },
  {
    name: "react-native",
    importNames: ["RefreshControl"],
    message:
      "Use RefreshControl from src/components/ui/RefreshControl: Android bottom sheets own the pull at the top, so it steps aside there.",
  },
];

export const RESTRICTED_UI_VARIANT_PATTERNS = [
  {
    group: ["**/components/ui/*", "**/ui/*", "./ui/*"],
    importNames: ["buttonVariants", "toggleVariants", "badgeVariants", "selectTriggerVariants"],
    message:
      "Render the components/ui export instead of borrowing its class recipe (render={<Button …/>}, SelectButton, ToggleGroup).",
  },
];

export const RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS = {
  name: "lucide-react",
  importNames: [
    "GitMerge",
    "GitMergeIcon",
    "GitPullRequest",
    "GitPullRequestIcon",
    "GitPullRequestArrow",
    "GitPullRequestArrowIcon",
    "GitPullRequestClosed",
    "GitPullRequestClosedIcon",
    "GitPullRequestDraft",
    "GitPullRequestDraftIcon",
    "GitPullRequestCreate",
    "GitPullRequestCreateIcon",
    "GitPullRequestCreateArrow",
    "GitPullRequestCreateArrowIcon",
  ],
  message:
    "Pick a glyph by meaning from PullRequestGlyph in apps/web/src/components/pullRequest/pullRequestIcons.tsx so every surface draws the same pull request the same way.",
};
