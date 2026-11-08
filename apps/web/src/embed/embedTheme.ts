import { useSyncExternalStore } from "react";

import { syncBrowserChromeTheme } from "../hooks/useTheme";
import {
  applyThemeColorPreview,
  getStandardThemeColors,
  getThemeColorVariable,
  isThemeColor,
  THEME_COLOR_ROLES,
  type ThemeColorRole,
  type ThemeColors,
} from "../themePalette";
import type { EmbedScheme, EmbedThemeMessage } from "./embedProtocol";

export type EmbedTheme = {
  readonly scheme: EmbedScheme;
  readonly colors: ThemeColors;
  readonly overrides: Readonly<Record<string, string>>;
};

const ROLE_BY_VARIABLE: ReadonlyMap<string, ThemeColorRole> = new Map(
  THEME_COLOR_ROLES.map((role) => [getThemeColorVariable(role), role]),
);

const OVERRIDABLE = new Set([
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--radius",
  "--font-sans",
  "--font-mono",
]);

let current: EmbedTheme | null = null;
let appliedOverrides: ReadonlyArray<string> = [];
const listeners = new Set<() => void>();

export function themeFromEmbedMessage(
  message: Pick<EmbedThemeMessage, "scheme" | "vars">,
): EmbedTheme {
  const roles: Partial<Record<ThemeColorRole, string>> = {};
  const overrides: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.vars)) {
    const role = ROLE_BY_VARIABLE.get(name);
    if (role !== undefined) {
      if (isThemeColor(value)) roles[role] = value;
    } else if (OVERRIDABLE.has(name)) {
      overrides[name] = value;
    }
  }
  return {
    scheme: message.scheme,
    colors: { ...getStandardThemeColors(message.scheme), ...roles },
    overrides,
  };
}

export function applyEmbedTheme(theme: EmbedTheme): void {
  const root = document.documentElement;
  applyThemeColorPreview(theme.colors, theme.scheme);
  for (const name of appliedOverrides) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(theme.overrides)) root.style.setProperty(name, value);
  appliedOverrides = Object.keys(theme.overrides);
  root.style.colorScheme = theme.scheme;
  syncBrowserChromeTheme();
  current = theme;
  for (const listener of listeners) listener();
}

export function useEmbedTheme(): EmbedTheme | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
