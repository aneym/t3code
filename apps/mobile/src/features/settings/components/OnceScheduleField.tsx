import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { onceScheduleLabel } from "@t3tools/client-runtime/scheduled-task-once";
import { AppText as Text } from "../../../components/ui/AppText";

export function OnceScheduleField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const [picker, setPicker] = useState<"date" | "time" | null>(null);
  const [fallback] = useState(() => Date.now() + 3_600_000);
  const parsed = Date.parse(value);
  const date = new Date(Number.isFinite(parsed) ? parsed : fallback);
  return (
    <View className="gap-3 border-t border-border-subtle px-4 py-3">
      <Text textRole="body" className="text-foreground">
        {value ? onceScheduleLabel(date.toISOString()) : "Choose when to run once"}
      </Text>
      <View className="flex-row gap-6">
        {(["date", "time"] as const).map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityLabel={`Choose ${mode}`}
            onPress={() => setPicker(mode)}
          >
            <Text className="text-accent">{mode === "date" ? "Choose date" : "Choose time"}</Text>
          </Pressable>
        ))}
      </View>
      {picker ? (
        <DateTimePicker
          value={date}
          mode={picker}
          display={Platform.OS === "ios" ? "spinner" : "default"}
          onDismiss={() => setPicker(null)}
          onValueChange={(_, selected) => onChange(selected.toISOString())}
        />
      ) : null}
      <Text className="text-sm text-foreground-muted">
        Your local time. Disables after one run. Change its time or enable it again to re-arm.
      </Text>
    </View>
  );
}
