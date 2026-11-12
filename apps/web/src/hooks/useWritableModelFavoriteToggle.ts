import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentScope } from "~/state/session";
import { useToggleEnvironmentModelFavorite } from "./useSettings";

export function useWritableModelFavoriteToggle(environmentId: EnvironmentId | null) {
  const toggle = useToggleEnvironmentModelFavorite(environmentId);
  return useEnvironmentScope(environmentId, AuthSettingsWriteScope) ? toggle : null;
}
