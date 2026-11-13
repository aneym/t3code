import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelName } from "./providerIconUtils";

const EMPTY_PROVIDER_MODELS: ServerProvider["models"] = [];

export function resolveProviderSubagentLabels(
  entry: ProviderInstanceEntry | undefined,
  selection: ModelSelection | undefined,
  reportedSelection: ModelSelection | null,
): { readonly modelLabel: string; readonly effortLabel: string | null } {
  const models = entry?.models ?? EMPTY_PROVIDER_MODELS;
  // Providers can report dated model ids or aliases.
  const slug = entry ? resolveSelectableModel(entry.driverKind, selection?.model, models) : null;
  const catalogModel = models.find((model) => model.slug === slug);
  return {
    modelLabel: catalogModel
      ? getTriggerDisplayModelName(catalogModel, entry?.driverKind)
      : formatModelSlugName(selection?.model ?? ""),
    effortLabel:
      selection === undefined
        ? null
        : formatModelSelectionEffort(selection, models, reportedSelection),
  };
}
