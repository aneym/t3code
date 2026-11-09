import { useAtomValue } from "@effect/atom-react";
import {
  LANE_RESULT_STATE_LABELS,
  type LaneResult,
  type LaneResultState,
} from "@t3tools/client-runtime/lane-result";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { type ColorValue, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { ThreadDisclosureChevron } from "./thread-work-log";

const MARK_CLASS: Record<LaneResultState, string> = {
  finished: "bg-foreground-secondary",
  dropped: "border border-foreground-secondary",
  failed: "bg-danger",
};

const EMPTY_DETAIL: Record<LaneResultState, string> = {
  finished: "The lane left no result.",
  dropped: "The lane left no reason.",
  failed: "Rails gave no reason.",
};

export function useLaneResultRows(environmentId: EnvironmentId): boolean {
  return (
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.laneResultRowsEnabled ?? true
  );
}

export function ThreadLaneResultRow(props: {
  readonly lane: LaneResult;
  readonly tint: ColorValue;
}) {
  const [expanded, setExpanded] = useState(false);
  const title = props.lane.title || "A lane";
  const state = LANE_RESULT_STATE_LABELS[props.lane.state];
  return (
    <View className="mb-4 items-start">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title} ${state}`}
        accessibilityState={{ expanded }}
        hitSlop={4}
        className="min-h-8 max-w-full flex-row items-center gap-1.5 py-1"
        onPress={() => {
          void Haptics.selectionAsync();
          setExpanded((value) => !value);
        }}
      >
        <ThreadDisclosureChevron
          expanded={expanded}
          collapsedDirection="right"
          size={11}
          tintColor={props.tint}
        />
        <View className={`size-1.5 rounded-full ${MARK_CLASS[props.lane.state]}`} />
        <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-secondary">
          {title}
        </Text>
        <Text className="text-xs text-foreground-secondary">· {state}</Text>
      </Pressable>
      {expanded ? (
        <View className="ml-[5px] mt-1 border-l border-border pl-3">
          <Text selectable className="text-xs leading-5 text-foreground-secondary">
            {props.lane.detail || EMPTY_DETAIL[props.lane.state]}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
