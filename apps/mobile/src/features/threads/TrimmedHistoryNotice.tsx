import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function TrimmedHistoryNotice(props: { readonly trimmedAt: string }) {
  return (
    <View className="px-4 pb-3 pt-1">
      <Text className="text-center text-xs text-foreground-tertiary">
        Tool output and agent work in this thread were removed on{" "}
        {DATE_FORMAT.format(new Date(props.trimmedAt))} to save space. Messages were kept.
      </Text>
    </View>
  );
}
