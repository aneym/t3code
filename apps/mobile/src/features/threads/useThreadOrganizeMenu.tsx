import type { NativeStackHeaderItemMenu } from "@react-navigation/native-stack";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  canSnooze,
  effectiveSnoozed,
  resolveSnoozePresets,
} from "@t3tools/client-runtime/state/thread-settled";
import { AuthOrchestrationOperateScope, type ServerConfig } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useThreadListActions } from "../home/useThreadListActions";
import { useEnvironmentScope } from "../../state/session";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";

function nativeItems(
  items: ReadonlyArray<AppBarMenuItem>,
): NativeStackHeaderItemMenu["menu"]["items"] {
  return items.map((item) =>
    "items" in item
      ? { type: "submenu", label: item.title ?? "", items: nativeItems(item.items) }
      : {
          type: "action",
          label: item.title,
          disabled: item.disabled,
          state: item.selected ? "on" : undefined,
          description: item.subtitle,
          icon: item.icon ? { type: "sfSymbol", name: item.icon as never } : undefined,
          onPress: item.onPress,
        },
  );
}

export function useThreadOrganizeMenu(
  thread: EnvironmentThreadShell | undefined,
  config: ServerConfig | null,
) {
  const actions = useThreadListActions();
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const [customSnoozeTarget, setCustomSnoozeTarget] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
      const timer = setInterval(() => setNow(new Date()), 60_000);
      return () => clearInterval(timer);
    }, []),
  );
  if (!thread) return { menu: undefined, nativeItem: undefined, sheet: null };
  const target = thread;
  const targetKey = `${thread.environmentId}:${thread.id}`;
  const snoozed = effectiveSnoozed(thread, { now: now.toISOString() });
  const capabilities = config?.environment.capabilities;
  const items: AppBarMenuItem[] = [];
  if (capabilities?.threadPinning) {
    const pinned = thread.pinnedAt != null;
    items.push({
      id: "pin",
      title: pinned ? "Unpin" : "Pin",
      icon: pinned ? "pin.slash" : "pin",
      disabled: !canOperate,
      selected: pinned,
      onPress: () => {
        void (pinned ? actions.unpinThread(target) : actions.pinThread(target));
      },
    });
  }
  if (capabilities?.threadSettlement) {
    const settled = thread.settledOverride === "settled";
    items.push({
      id: "settle",
      title: settled ? "Un-settle" : "Settle",
      icon: settled ? "arrow.uturn.backward" : "checkmark",
      disabled: !canOperate,
      selected: settled,
      onPress: () => {
        void (settled ? actions.unsettleThread(target) : actions.settleThread(target));
      },
    });
  }
  if (capabilities?.threadSnooze) {
    if (snoozed) {
      items.push({
        id: "unsnooze",
        title: "Wake thread",
        icon: "clock",
        disabled: !canOperate,
        onPress: () => {
          void actions.unsnoozeThread(target);
        },
      });
    } else if (canOperate && canSnooze(thread, { now: now.toISOString() })) {
      items.push({
        id: "snooze",
        title: "Snooze",
        icon: "clock",
        items: [
          ...resolveSnoozePresets(now).map((preset) => ({
            id: preset.id,
            title: preset.label,
            subtitle: preset.whenLabel,
            onPress: () => {
              void actions.snoozeThread(target, preset.snoozedUntil);
            },
          })),
          { id: "custom", title: "Custom…", onPress: () => setCustomSnoozeTarget(targetKey) },
        ],
      });
    }
  }
  const menu: AppBarMenu | undefined = items.length
    ? {
        title: "Thread actions",
        icon: thread.pinnedAt != null ? "pin" : "ellipsis.circle",
        items,
      }
    : undefined;
  const nativeItem: NativeStackHeaderItemMenu | undefined = menu
    ? {
        type: "menu",
        label: menu.title,
        accessibilityLabel: menu.title,
        icon: { type: "sfSymbol", name: thread.pinnedAt != null ? "pin" : "ellipsis.circle" },
        menu: { title: menu.title, items: nativeItems(items) },
      }
    : undefined;
  return {
    menu,
    nativeItem,
    sheet:
      customSnoozeTarget === targetKey ? (
        <CustomSnoozeSheet
          onClose={() => setCustomSnoozeTarget(null)}
          onSnooze={(until) => {
            void actions.snoozeThread(target, until);
          }}
        />
      ) : null,
  };
}
