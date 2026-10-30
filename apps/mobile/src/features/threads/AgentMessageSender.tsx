import * as Haptics from "expo-haptics";
import { Pressable, type ColorValue } from "react-native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useQuietThreadShell } from "../../state/entities";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import { ThreadDisclosureChevron } from "./thread-work-log";

export function AgentMessageFoldHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId?: ThreadId;
  readonly summary: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly iconSubtleColor: ColorValue;
}) {
  const senderShell = useQuietThreadShell(
    props.senderThreadId ? scopeThreadRef(props.environmentId, props.senderThreadId) : null,
  );
  const label = senderShell?.title.trim() || "Agent";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${props.summary}`}
      accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} the message.`}
      accessibilityState={{ expanded: props.expanded }}
      hitSlop={4}
      className="min-h-10 flex-row items-center gap-1.5 px-3.5 py-2"
      onPress={() => {
        void Haptics.selectionAsync();
        props.onToggle();
      }}
    >
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={14}
        weight="medium"
        tintColorClassName="accent-user-bubble-foreground-muted"
        type="monochrome"
      />
      <Text
        numberOfLines={1}
        className="max-w-[50%] shrink-0 font-t3-medium text-sm text-user-bubble-foreground-muted"
      >
        {label}
      </Text>
      <Text numberOfLines={1} className="min-w-0 shrink text-sm text-user-bubble-foreground">
        {props.summary}
      </Text>
      <ThreadDisclosureChevron
        expanded={props.expanded}
        collapsedDirection="down"
        size={11}
        tintColor={props.iconSubtleColor}
      />
    </Pressable>
  );
}

export function OpenSenderThreadButton(props: {
  readonly environmentId: EnvironmentId;
  readonly senderThreadId: ThreadId;
}) {
  const openLinkedThread = useOpenLinkedThread();
  return (
    <Pressable
      accessibilityRole="link"
      hitSlop={6}
      onPress={() =>
        openLinkedThread({
          environmentId: String(props.environmentId),
          threadId: String(props.senderThreadId),
        })
      }
    >
      <Text className="font-t3-medium text-xs text-foreground-secondary">Open thread</Text>
    </Pressable>
  );
}
