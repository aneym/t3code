import {
  RAILS_COMMENT_KIND_LABELS,
  type RailsComment,
} from "@t3tools/client-runtime/rails-comment";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";

export function ThreadRailsCommentCard(props: { readonly comment: RailsComment }) {
  const { comment } = props;
  const where = comment.docTitle ?? "a page";
  const pinUrl = comment.pinUrl;
  return (
    <View className="mb-4 items-start">
      <View className="w-full max-w-[85%] gap-2 rounded-2xl border border-border bg-card px-3 py-2.5">
        <View className="flex-row items-center gap-1.5">
          <SymbolView name="text.bubble" size={13} tintColorClassName="accent-icon-muted" />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-secondary">
            <Text className="text-xs font-medium text-foreground">{comment.author}</Text>
            {" on "}
            <Text className="text-xs font-medium text-foreground">{where}</Text>
          </Text>
          <View className="rounded bg-subtle px-1.5 py-0.5">
            <Text className="text-2xs font-medium text-foreground-secondary">
              {RAILS_COMMENT_KIND_LABELS[comment.kind]}
            </Text>
          </View>
        </View>
        {comment.quote !== null || comment.label !== null ? (
          <View className="border-l border-border pl-2.5">
            {comment.label !== null ? (
              <Text className="text-xs font-medium text-foreground-secondary">{comment.label}</Text>
            ) : null}
            {comment.quote !== null ? (
              <Text numberOfLines={3} className="text-xs leading-5 text-foreground-secondary">
                {comment.quote}
              </Text>
            ) : null}
          </View>
        ) : null}
        <Text selectable className="text-sm leading-5 text-foreground">
          {comment.text}
        </Text>
        {pinUrl !== null ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open comment on ${where}`}
            hitSlop={6}
            className="flex-row items-center gap-1 self-start py-0.5 active:opacity-60"
            onPress={() => void tryOpenExternalUrl(pinUrl, "rails-comment")}
          >
            <Text className="text-xs text-foreground-secondary">Open comment</Text>
            <SymbolView name="arrow.up.right" size={11} tintColorClassName="accent-icon-muted" />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
