import { useAtomValue } from "@effect/atom-react";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { mobilePreferencesAtom } from "../../state/preferences";

export function TurnDiffStat(props: {
  readonly checkpoint: ThreadCheckpointSummary;
  readonly onOpenTurnDiff: (checkpoint: ThreadCheckpointSummary) => void;
}) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  if (
    AsyncResult.isSuccess(preferences) &&
    !(preferences.value.showChatChangedFiles ?? DEFAULT_CLIENT_SETTINGS.showChatChangedFiles)
  ) {
    return null;
  }

  const { files } = props.checkpoint;
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const fileCountLabel = `${files.length} file${files.length === 1 ? "" : "s"} changed`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review ${fileCountLabel}, ${additions} additions, ${deletions} deletions`}
      onPress={() => props.onOpenTurnDiff(props.checkpoint)}
      className="min-h-11 shrink-0 flex-row items-center gap-2 px-2 active:bg-subtle"
    >
      <Text className="font-t3-medium text-xs tabular-nums text-adaptive-emerald-700-300">
        +{formatDiffCount(additions)}
      </Text>
      <Text className="font-t3-medium text-xs tabular-nums text-adaptive-rose-700-300">
        −{formatDiffCount(deletions)}
      </Text>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}
