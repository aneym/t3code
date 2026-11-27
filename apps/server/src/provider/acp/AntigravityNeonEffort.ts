import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";

const NEON_MODEL = "gemini-4-neon";
const NEON_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const NEON_EFFORT_OPTION = "thought_level";

function neonEffortModels(models: ReadonlySet<string>) {
  return models.has(NEON_MODEL)
    ? NEON_LEVELS.flatMap((level) => {
        const model = `${NEON_MODEL}-${level}`;
        return models.has(model) ? [{ model, level }] : [];
      })
    : [];
}

export function withNeonEffortPicker(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const variants = neonEffortModels(new Set(models.map((model) => model.slug)));
  if (variants.length === 0) return models;
  const base = models.find((model) => model.slug === NEON_MODEL);
  if (!base) return models;
  const variantIds = variants.map((variant) => variant.model);
  const defaultModel = models.find((model) => model.isDefault && variantIds.includes(model.slug));
  return models.flatMap((model) => {
    if (variantIds.includes(model.slug)) return [];
    if (model !== base) return [model];
    return [
      {
        ...base,
        ...(defaultModel ? { isDefault: true } : {}),
        aliases: [
          ...new Set([...(base.aliases ?? []), ...(defaultModel?.aliases ?? []), ...variantIds]),
        ],
        capabilities: createModelCapabilities({
          optionDescriptors: [
            ...(base.capabilities?.optionDescriptors ?? []).filter(
              (descriptor) => descriptor.type !== "select" || descriptor.role !== "reasoning",
            ),
            {
              id: NEON_EFFORT_OPTION,
              label: "Effort",
              type: "select",
              role: "reasoning",
              options: variants.map(({ level }) => ({
                id: level,
                label:
                  level === "xhigh" ? "Extra high" : level.charAt(0).toUpperCase() + level.slice(1),
                ...(level === "high" ? { isDefault: true } : {}),
              })),
            },
          ],
        }),
      },
    ];
  });
}

export function neonEffortModel(
  model: string | undefined,
  selection: ModelSelection,
  availableModels: ReadonlySet<string>,
): string | undefined {
  if (model !== NEON_MODEL) return undefined;
  const level = getModelSelectionStringOptionValue(selection, NEON_EFFORT_OPTION) ?? "high";
  return neonEffortModels(availableModels).find((variant) => variant.level === level)?.model;
}
