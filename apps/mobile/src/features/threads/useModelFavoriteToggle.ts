import { RegistryContext } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import { AsyncResult } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { use, useRef } from "react";
import { Alert } from "react-native";
import type { ModelOption } from "../../lib/modelOptions";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export function useModelFavoriteToggle(input: {
  readonly environmentId: EnvironmentId | null;
  readonly favoritesLoaded: boolean;
  readonly legacyFavorites: ReadonlyArray<{
    readonly provider: ProviderInstanceId;
    readonly model: string;
  }>;
}) {
  const registry = use(RegistryContext);
  const pendingFavorites = useRef(
    new Map<string, { favorite: boolean; settings: ServerSettings; pending: boolean }>(),
  );
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "model favorites update",
    reportFailure: false,
  });
  const favoritesWritable = useEnvironmentScope(input.environmentId, AuthSettingsWriteScope);
  const toggleFavorite = async (option: ModelOption) => {
    const environmentId = input.environmentId;
    if (!input.favoritesLoaded || !favoritesWritable || !environmentId) return;
    const currentSettings = registry.get(environmentServerConfigsAtom).get(environmentId)?.settings;
    if (!currentSettings) return;
    const favorites = resolveModelPreferences(currentSettings, {
      favorites: input.legacyFavorites,
    }).favorites;
    const key = JSON.stringify([
      environmentId,
      option.selection.instanceId,
      option.selection.model,
    ]);
    const previous = pendingFavorites.current.get(key);
    const previousFavorite =
      previous && (previous.pending || previous.settings.favorites === currentSettings.favorites)
        ? previous.favorite
        : favorites.some(
            (favorite) =>
              favorite.provider === option.selection.instanceId &&
              favorite.model === option.selection.model,
          );
    const pending = { favorite: !previousFavorite, settings: currentSettings, pending: true };
    pendingFavorites.current.set(key, pending);
    void Haptics.selectionAsync();
    const result = await saveSettings({
      environmentId: environmentId,
      input: {
        patch: {
          setModelFavorites: [
            {
              provider: option.selection.instanceId,
              model: option.selection.model,
              favorite: pending.favorite,
            },
          ],
          ...(currentSettings.favorites === null ? { migrateModelPreferences: { favorites } } : {}),
        },
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Alert.alert(
        "Favorite not saved",
        error instanceof Error
          ? error.message
          : "The save failed. Try reconnecting and saving again.",
      );
    }
    if (
      AsyncResult.isSuccess(result) &&
      registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
        currentSettings.favorites
    ) {
      pending.pending = false;
    }
    if (pending.pending && pendingFavorites.current.get(key) === pending) {
      if (
        previous &&
        !previous.pending &&
        registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
          previous.settings.favorites
      ) {
        pendingFavorites.current.set(key, previous);
      } else {
        pendingFavorites.current.delete(key);
      }
    }
  };
  return { favoritesWritable, toggleFavorite };
}
