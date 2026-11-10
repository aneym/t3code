import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  type LegacyProjectSettingsFields,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { providerConstraints } from "../mcp/providerConstraints.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const defaultModel = (provider: ServerProvider) =>
  provider.models.find((model) => model.isDefault === true && !model.isCustom)?.slug ??
  provider.models.find((model) => !model.isCustom)?.slug ??
  provider.models[0]?.slug ??
  DEFAULT_MODEL_BY_PROVIDER[provider.driver];

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;

  const resolve = Effect.fn("NewThreadModelSelection.resolve")(function* (input: {
    readonly projectId: ProjectId;
    readonly project: LegacyProjectSettingsFields | null | undefined;
  }) {
    const settings = yield* serverSettings.getSettings;
    const effective = resolveProjectSettings(settings, input.projectId, input.project).settings;
    const ready = (provider: ServerProvider | undefined): provider is ServerProvider =>
      provider !== undefined &&
      providerConstraints(provider, true).length === 0 &&
      resolveProjectProviderInstanceEnabled(settings, input.projectId, provider.instanceId);
    const providers = yield* registry.getProviders;
    const preferred = resolveNewThreadModelSelection({
      defaultSelection: effective.defaultModelSelection,
      fallbackSelection: effective.fallbackModelSelection,
      providers,
      settings: effective,
      projectId: input.projectId,
      now: DateTime.toEpochMillis(yield* DateTime.now),
    }).selection;
    if (
      preferred !== null &&
      ready(providers.find((provider) => provider.instanceId === preferred.instanceId))
    )
      return preferred;
    const candidate =
      providers.find((provider) => ready(provider) && provider.status === "ready") ??
      providers.find(ready);
    const model = candidate === undefined ? undefined : defaultModel(candidate);
    return candidate !== undefined && model !== undefined
      ? ({ instanceId: candidate.instanceId, model } satisfies ModelSelection)
      : preferred;
  });

  return { resolve };
});
