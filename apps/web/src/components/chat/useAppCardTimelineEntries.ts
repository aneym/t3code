import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import { serverEnvironment } from "../../state/server";
import { appCardHostSupported, withAppCardEntries } from "./appCardFrame.logic";

export function useAppCardTimelineEntries(
  entries: ReadonlyArray<TimelineEntry>,
  environmentId: EnvironmentId,
): ReadonlyArray<TimelineEntry> {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  if (settings == null || !settings.appCardsEnabled || !appCardHostSupported(navigator.userAgent)) {
    return entries;
  }
  return withAppCardEntries(entries, settings.appCardAllowedOrigins);
}
